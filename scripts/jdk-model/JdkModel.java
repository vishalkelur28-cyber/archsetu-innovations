import java.io.IOException;
import java.lang.classfile.Annotation;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Extracts the model of the Java standard library that ArchSetu's Java call
 * resolver uses to pick overloads and to type chained calls: for every public
 * type in a fixed list of packages, its supertypes, whether it is final or an
 * interface, and what each of its methods returns.
 *
 * <pre>
 *     java JdkModel.java &lt;out.json&gt; &lt;out.ts&gt;
 * </pre>
 *
 * Everything comes from the JDK running this program, by reflection over the
 * classes listed in its {@code jrt:/} image, so the JDK that runs it is the
 * JDK that is modelled. Nothing in the output is written by hand.
 *
 * <p>Rules:
 * <ul>
 * <li>Public top-level types and public nested types (whose enclosing types
 *     are public too). A nested type is keyed by its simple name ({@code Entry})
 *     and by its name within its top-level type ({@code Map.Entry}).
 * <li>When two types claim one key, the type from the earlier package in
 *     {@link #PACKAGES} keeps it; within a package a top-level type beats a
 *     nested one, a shallower nested type beats a deeper one, and otherwise the
 *     alphabetically first binary name wins. Every loser is reported.
 * <li>{@code final} is true for final classes, enums and records.
 * <li>Supertypes are every accessible supertype, transitively, plus
 *     {@code Object} for interfaces. Package-private supertypes such as
 *     {@code AbstractStringBuilder} are left out: no caller can name them.
 * <li>Methods are {@code Class.getMethods()}: public, declared or inherited,
 *     static or instance. Bridge methods javac generates for generics and
 *     covariant returns are skipped (the real method is listed); a visibility
 *     bridge (a public class re-exposing a method of a package-private
 *     superclass) stands for the method it re-exposes. For each parameter
 *     list the most specific return type wins, the way an override would.
 * <li>A return type is erased and named the way the model names it: a type
 *     variable is {@code ?}, {@code Stream<T>} is {@code Stream}, arrays are
 *     {@code X[]}. A variable of a generic supertype that the type itself
 *     binds is what it binds: Stream extends BaseStream&lt;T, Stream&lt;T&gt;&gt;,
 *     so Stream's parallel() is {@code Stream}, while List.get's E stays
 *     {@code ?}. A type whose simple name the model gives to a different
 *     type (it lost a collision, or lies outside the modelled packages) is
 *     {@code ?} rather than a wrong name. If the overloads of a name disagree,
 *     the name maps to {@code ?}.
 * </ul>
 */
public class JdkModel {

    /** A package to model and the module that holds it. */
    private record Pkg(String module, String name) {}

    /** Priority order: on a simple-name collision the earlier package keeps the name. */
    private static final List<Pkg> PACKAGES = List.of(
            base("java.lang"),
            base("java.util"),
            base("java.util.function"),
            base("java.util.stream"),
            base("java.io"),
            base("java.nio.file"),
            base("java.nio"),
            base("java.nio.charset"),
            base("java.math"),
            base("java.time"),
            base("java.time.format"),
            base("java.time.temporal"),
            base("java.util.concurrent"),
            base("java.util.concurrent.atomic"),
            base("java.util.concurrent.locks"),
            base("java.util.regex"),
            base("java.net"),
            base("java.text"),
            // Last, so a java.sql type only gets a name nothing above already
            // has: java.sql.Date loses to java.util.Date.
            new Pkg("java.sql", "java.sql"));

    /** Dropped, together, if the TypeScript module would be larger than TS_BUDGET bytes. */
    private static final List<String> DROPPABLE = List.of("java.text", "java.net");

    private static final int TS_BUDGET = 250 * 1024;

    /** Members of Object, left out of the TypeScript module unless a type gives one another return type. */
    private static final Set<String> OBJECT_MEMBERS =
            Set.of("equals", "hashCode", "toString", "getClass", "notify", "notifyAll", "wait");

    private static final String PREVIEW_ANNOTATION = "Ljdk/internal/javac/PreviewFeature;";

    private static Pkg base(String name) {
        return new Pkg("java.base", name);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: java JdkModel.java <out.json> <out.ts>");
            System.exit(2);
        }
        FileSystem jrt = FileSystems.getFileSystem(URI.create("jrt:/"));

        Model model = new Model(jrt, PACKAGES);
        String ts = model.typescript();
        List<String> droppedForSize = List.of();
        if (utf8Length(ts) > TS_BUDGET) {
            System.out.printf("TypeScript module with every package: %,d bytes, over the %,d budget; dropping %s%n",
                    utf8Length(ts), TS_BUDGET, String.join(" and ", DROPPABLE));
            droppedForSize = DROPPABLE;
            model = new Model(jrt, PACKAGES.stream().filter(p -> !DROPPABLE.contains(p.name())).toList());
            ts = model.typescript();
        }
        String json = model.json(droppedForSize);

        Path jsonOut = Path.of(args[0]);
        Path tsOut = Path.of(args[1]);
        Files.writeString(jsonOut, json, StandardCharsets.UTF_8);
        Files.writeString(tsOut, ts, StandardCharsets.UTF_8);

        model.printSummary(droppedForSize);
        System.out.printf("wrote %s (%,d bytes)%n", jsonOut, Files.size(jsonOut));
        System.out.printf("wrote %s (%,d bytes, budget %,d)%n", tsOut, Files.size(tsOut), TS_BUDGET);
        if (utf8Length(ts) > TS_BUDGET) {
            System.out.println("WARNING: the TypeScript module is still over budget after dropping "
                    + String.join(" and ", DROPPABLE));
        }
    }

    private static String jdkVersion() {
        return Runtime.version().toString();
    }

    private static int utf8Length(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    /** A modelled type, the package priority it came from, and whether it is a preview API. */
    private record Found(Class<?> type, int priority, boolean preview) {
        int depth() {
            int depth = 0;
            for (Class<?> k = type.getEnclosingClass(); k != null; k = k.getEnclosingClass()) depth++;
            return depth;
        }

        /** {@code Map.Entry} for java.util.Map.Entry; the simple name for a top-level type. */
        String nestedName() {
            return type.getCanonicalName().substring(type.getPackageName().length() + 1);
        }
    }

    private record Collision(String key, Found kept, Found dropped) {}

    /** One type as the resolver sees it. Methods hold every name; the TypeScript module filters. */
    private record TypeModel(boolean isFinal, boolean isInterface, List<String> supertypes, TreeMap<String, String> methods) {}

    private static final class Model {
        private final List<Pkg> packages;
        private final List<Found> found = new ArrayList<>();
        private final List<String> loadFailures = new ArrayList<>();
        private final TreeMap<String, Found> byKey = new TreeMap<>();
        private final Map<Class<?>, String> nameOf = new HashMap<>();
        private final List<Collision> collisions = new ArrayList<>();
        private final Map<Class<?>, TypeModel> models = new HashMap<>();
        /** Types a method or supertype referred to whose simple name the model gives to another type. */
        private final TreeSet<String> unnamable = new TreeSet<>();

        Model(FileSystem jrt, List<Pkg> packages) throws IOException {
            this.packages = packages;
            ClassLoader loader = ClassLoader.getSystemClassLoader();
            for (int priority = 0; priority < packages.size(); priority++) {
                Pkg pkg = packages.get(priority);
                Path dir = jrt.getPath("/modules", pkg.module(), pkg.name().replace('.', '/'));
                List<Path> files;
                try (Stream<Path> listing = Files.list(dir)) {
                    files = listing.filter(Files::isRegularFile)
                            .filter(f -> f.getFileName().toString().endsWith(".class"))
                            .sorted(Comparator.comparing(Path::toString))
                            .toList();
                }
                Map<String, Boolean> previewAnnotated = new HashMap<>();
                List<String> names = new ArrayList<>();
                for (Path file : files) {
                    String fileName = file.getFileName().toString();
                    String local = fileName.substring(0, fileName.length() - ".class".length());
                    if (local.equals("module-info") || local.equals("package-info") || !isMemberName(local)) continue;
                    String binary = pkg.name() + "." + local;
                    previewAnnotated.put(binary, isPreviewAnnotated(Files.readAllBytes(file)));
                    names.add(binary);
                }
                for (String binary : names) {
                    Class<?> type;
                    try {
                        type = Class.forName(binary, false, loader);
                    } catch (Throwable e) {
                        loadFailures.add(binary + ": " + e);
                        continue;
                    }
                    if (type.isAnonymousClass() || type.isLocalClass() || type.isSynthetic() || type.isHidden()) continue;
                    if (!isAccessible(type)) continue;
                    boolean preview = false;
                    for (Class<?> k = type; k != null; k = k.getEnclosingClass()) {
                        preview |= previewAnnotated.getOrDefault(k.getName(), false);
                    }
                    found.add(new Found(type, priority, preview));
                }
            }
            assignKeys();
        }

        private void assignKeys() {
            Map<String, List<Found>> claims = new TreeMap<>();
            for (Found f : found) {
                claims.computeIfAbsent(f.type().getSimpleName(), k -> new ArrayList<>()).add(f);
                if (f.depth() > 0) claims.computeIfAbsent(f.nestedName(), k -> new ArrayList<>()).add(f);
            }
            Comparator<Found> precedence = Comparator.comparingInt(Found::priority)
                    .thenComparingInt(Found::depth)
                    .thenComparing(f -> f.type().getName());
            for (Map.Entry<String, List<Found>> claim : claims.entrySet()) {
                List<Found> claimants = new ArrayList<>(claim.getValue());
                claimants.sort(precedence);
                Found winner = claimants.get(0);
                byKey.put(claim.getKey(), winner);
                for (Found loser : claimants.subList(1, claimants.size())) {
                    collisions.add(new Collision(claim.getKey(), winner, loser));
                }
            }
            // A type is referred to by its simple name when it holds that key, else by Outer.Inner.
            for (Map.Entry<String, Found> e : byKey.entrySet()) {
                Class<?> type = e.getValue().type();
                if (e.getKey().equals(type.getSimpleName())) nameOf.put(type, e.getKey());
            }
            for (Map.Entry<String, Found> e : byKey.entrySet()) {
                nameOf.putIfAbsent(e.getValue().type(), e.getKey());
            }
        }

        TypeModel model(Class<?> type) {
            TypeModel m = models.get(type);
            if (m == null) {
                boolean isFinal = Modifier.isFinal(type.getModifiers()) || type.isEnum() || type.isRecord();
                m = new TypeModel(isFinal, type.isInterface(), supertypes(type), methods(type));
                models.put(type, m);
            }
            return m;
        }

        private List<String> supertypes(Class<?> type) {
            Set<Class<?>> all = new LinkedHashSet<>();
            Deque<Class<?>> work = new ArrayDeque<>();
            work.add(type);
            while (!work.isEmpty()) {
                Class<?> k = work.poll();
                if (k.getSuperclass() != null && all.add(k.getSuperclass())) work.add(k.getSuperclass());
                for (Class<?> i : k.getInterfaces()) {
                    if (all.add(i)) work.add(i);
                }
            }
            if (type.isInterface()) all.add(Object.class);
            all.remove(type);
            TreeSet<String> names = new TreeSet<>();
            for (Class<?> s : all) {
                if (!isAccessible(s)) continue;
                String name = className(s);
                if (name != null) names.add(name);
            }
            return List.copyOf(names);
        }

        private TreeMap<String, String> methods(Class<?> type) {
            Map<String, List<Method>> bySignature = new TreeMap<>();
            for (Method m : type.getMethods()) {
                Method effective = m;
                if (m.isBridge() || m.isSynthetic()) {
                    if (bridgesToDeclaredMethod(m)) continue;
                    effective = visibilityBridgeTarget(m);
                }
                String signature = m.getName() + Arrays.toString(m.getParameterTypes());
                bySignature.computeIfAbsent(signature, k -> new ArrayList<>()).add(effective);
            }
            Map<TypeVariable<?>, Type> bindings = typeArguments(type);
            Map<String, Set<String>> returnsByName = new TreeMap<>();
            for (List<Method> overriders : bySignature.values()) {
                returnsByName.computeIfAbsent(overriders.get(0).getName(), k -> new TreeSet<>())
                        .add(mostSpecificReturn(overriders, bindings));
            }
            TreeMap<String, String> methods = new TreeMap<>();
            for (Map.Entry<String, Set<String>> e : returnsByName.entrySet()) {
                methods.put(e.getKey(), e.getValue().size() == 1 ? e.getValue().iterator().next() : "?");
            }
            return methods;
        }

        /**
         * The methods sharing one name and parameter list: an override and what
         * it overrides, possibly with covariant returns. The result is the return
         * type of the one whose return type is assignable to all the others.
         */
        private String mostSpecificReturn(List<Method> overriders, Map<TypeVariable<?>, Type> bindings) {
            List<Method> best = new ArrayList<>();
            for (Method m : overriders) {
                boolean dominates = true;
                for (Method o : overriders) {
                    if (!o.getReturnType().isAssignableFrom(m.getReturnType())
                            || (o.getReturnType() == m.getReturnType()
                                    && !o.getDeclaringClass().isAssignableFrom(m.getDeclaringClass()))) {
                        dominates = false;
                        break;
                    }
                }
                if (dominates) best.add(m);
            }
            if (best.isEmpty()) best = overriders;
            Set<String> names = new TreeSet<>();
            for (Method m : best) names.add(typeName(genericReturnType(m), bindings, 0));
            return names.size() == 1 ? names.iterator().next() : "?";
        }

        /**
         * What the type variables of each generic supertype of {@code type} stand
         * for in {@code type}. Stream<T> extends BaseStream<T, Stream<T>>, so in
         * Stream the S that BaseStream.parallel() returns is Stream. A variable
         * left unbound (Stream's own T, or a method's own R) is unknown.
         */
        private static Map<TypeVariable<?>, Type> typeArguments(Class<?> type) {
            Map<TypeVariable<?>, Type> bindings = new HashMap<>();
            Deque<Type> work = new ArrayDeque<>();
            Set<Class<?>> seen = new HashSet<>();
            work.add(type);
            while (!work.isEmpty()) {
                Type t = work.poll();
                Class<?> raw = (Class<?>) (t instanceof ParameterizedType p ? p.getRawType() : t);
                if (t instanceof ParameterizedType p) {
                    TypeVariable<?>[] params = raw.getTypeParameters();
                    Type[] args = p.getActualTypeArguments();
                    for (int i = 0; i < params.length && i < args.length; i++) {
                        Type arg = args[i];
                        // Each subtype is dequeued before its own supertypes, so its variables are bound already.
                        while (arg instanceof TypeVariable<?> v && bindings.containsKey(v)) arg = bindings.get(v);
                        bindings.putIfAbsent(params[i], arg);
                    }
                }
                if (!seen.add(raw)) continue;
                if (raw.getGenericSuperclass() != null) work.add(raw.getGenericSuperclass());
                work.addAll(Arrays.asList(raw.getGenericInterfaces()));
            }
            return bindings;
        }

        private static Type genericReturnType(Method m) {
            try {
                return m.getGenericReturnType();
            } catch (RuntimeException | LinkageError e) {
                return m.getReturnType();
            }
        }

        /** A generic or covariant bridge: the method it forwards to is declared beside it. */
        private static boolean bridgesToDeclaredMethod(Method bridge) {
            Class<?>[] bridgeParams = bridge.getParameterTypes();
            for (Method d : bridge.getDeclaringClass().getDeclaredMethods()) {
                if (d.equals(bridge) || d.isBridge() || d.isSynthetic()) continue;
                if (!d.getName().equals(bridge.getName()) || d.getParameterCount() != bridgeParams.length) continue;
                if (!bridge.getReturnType().isAssignableFrom(d.getReturnType())) continue;
                Class<?>[] params = d.getParameterTypes();
                boolean forwards = true;
                for (int i = 0; i < params.length && forwards; i++) {
                    forwards = bridgeParams[i].isAssignableFrom(params[i]);
                }
                if (forwards) return true;
            }
            return false;
        }

        /** A visibility bridge re-exposes a superclass method; that method carries the generic signature. */
        private static Method visibilityBridgeTarget(Method bridge) {
            for (Class<?> s = bridge.getDeclaringClass().getSuperclass(); s != null; s = s.getSuperclass()) {
                try {
                    Method target = s.getDeclaredMethod(bridge.getName(), bridge.getParameterTypes());
                    if (!target.isBridge() && !target.isSynthetic()) return target;
                } catch (NoSuchMethodException e) {
                    // keep looking further up
                }
            }
            return bridge;
        }

        private String typeName(Type t, Map<TypeVariable<?>, Type> bindings, int depth) {
            if (t instanceof TypeVariable<?> v) {
                Type bound = bindings.get(v);
                return bound == null || depth > 16 ? "?" : typeName(bound, bindings, depth + 1);
            }
            if (t instanceof WildcardType) return "?";
            if (t instanceof ParameterizedType p) return typeName(p.getRawType(), bindings, depth);
            if (t instanceof GenericArrayType g) {
                return arrayOf(typeName(g.getGenericComponentType(), bindings, depth));
            }
            Class<?> c = (Class<?>) t;
            if (c.isArray()) return arrayOf(typeName(c.getComponentType(), bindings, depth));
            if (c.isPrimitive()) return c.getName();
            String name = className(c);
            return name == null ? "?" : name;
        }

        private static String arrayOf(String component) {
            return component.equals("?") ? "?" : component + "[]";
        }

        /**
         * The model's name for a class; its simple name if the model does not
         * hold it; null if that simple name belongs to a different type in the
         * model, because using it would claim the wrong type.
         */
        private String className(Class<?> c) {
            String name = nameOf.get(c);
            if (name != null) return name;
            if (byKey.containsKey(c.getSimpleName())) {
                unnamable.add(c.getName());
                return null;
            }
            return c.getSimpleName();
        }

        String typescript() {
            Map<String, String> objectMethods = model(Object.class).methods();
            StringBuilder out = new StringBuilder();
            out.append("""
                    /**
                     * The Java standard library's types, as the call resolver needs them: each
                     * type's supertypes, whether it is final, and what its methods return.
                     * Generated from JDK %s by scripts/jdk-model/JdkModel.java; do not edit by hand.
                     *
                     * Each entry is `flags|supertypes|methods`: flags `f` final, `i` interface;
                     * supertypes comma-separated; methods `name:ReturnType` comma-separated, `?`
                     * for a type variable or overloads that disagree.
                     */
                    export const JDK_TYPES: Readonly<Record<string, string>> = {
                    """.formatted(jdkVersion()));
            for (Map.Entry<String, Found> e : byKey.entrySet()) {
                Class<?> type = e.getValue().type();
                TypeModel m = model(type);
                String methods = m.methods().entrySet().stream()
                        .filter(x -> !x.getKey().startsWith("lambda$") && !x.getKey().contains("$"))
                        // Object's own entry keeps its members, so they are found through any supertype list.
                        .filter(x -> type == Object.class
                                || !OBJECT_MEMBERS.contains(x.getKey())
                                || !x.getValue().equals(objectMethods.get(x.getKey())))
                        .map(x -> x.getKey() + ":" + x.getValue())
                        .collect(Collectors.joining(","));
                String flags = (m.isFinal() ? "f" : "") + (m.isInterface() ? "i" : "");
                out.append("  ").append(tsKey(e.getKey())).append(": '")
                        .append(flags).append('|')
                        .append(String.join(",", m.supertypes())).append('|')
                        .append(methods).append("',\n");
            }
            out.append("};\n");
            return out.toString();
        }

        private static String tsKey(String key) {
            return key.matches("[A-Za-z_$][A-Za-z0-9_$]*") ? key : "'" + key + "'";
        }

        String json(List<String> droppedForSize) {
            StringBuilder out = new StringBuilder();
            out.append("{\n");
            out.append("  \"jdk\": {\"version\": ").append(q(jdkVersion()))
                    .append(", \"vendor\": ").append(q(System.getProperty("java.vendor")))
                    .append(", \"vendorVersion\": ").append(q(String.valueOf(System.getProperty("java.vendor.version"))))
                    .append("},\n");
            out.append("  \"generator\": \"scripts/jdk-model/JdkModel.java\",\n");
            out.append("  \"packages\": [")
                    .append(packages.stream().map(p -> q(p.name())).collect(Collectors.joining(", ")))
                    .append("],\n");
            out.append("  \"droppedForSize\": [")
                    .append(droppedForSize.stream().map(JdkModel::q).collect(Collectors.joining(", ")))
                    .append("],\n");
            out.append("  \"typeCount\": ").append(typeCount()).append(",\n");
            out.append("  \"keyCount\": ").append(byKey.size()).append(",\n");
            out.append("  \"types\": {\n");
            int i = 0;
            for (Map.Entry<String, Found> e : byKey.entrySet()) {
                Found f = e.getValue();
                TypeModel m = model(f.type());
                out.append("    ").append(q(e.getKey())).append(": {\n");
                out.append("      \"class\": ").append(q(f.type().getCanonicalName())).append(",\n");
                out.append("      \"final\": ").append(m.isFinal()).append(",\n");
                out.append("      \"interface\": ").append(m.isInterface()).append(",\n");
                if (f.preview()) out.append("      \"preview\": true,\n");
                out.append("      \"supertypes\": [")
                        .append(m.supertypes().stream().map(JdkModel::q).collect(Collectors.joining(", ")))
                        .append("],\n");
                out.append("      \"methods\": {");
                int j = 0;
                for (Map.Entry<String, String> me : m.methods().entrySet()) {
                    out.append(j++ == 0 ? "\n" : ",\n");
                    out.append("        ").append(q(me.getKey())).append(": ").append(q(me.getValue()));
                }
                out.append(j == 0 ? "}\n" : "\n      }\n");
                out.append(++i < byKey.size() ? "    },\n" : "    }\n");
            }
            out.append("  },\n");
            out.append("  \"collisions\": [");
            for (int c = 0; c < collisions.size(); c++) {
                Collision col = collisions.get(c);
                out.append(c == 0 ? "\n" : ",\n");
                out.append("    {\"name\": ").append(q(col.key()))
                        .append(", \"kept\": ").append(q(col.kept().type().getCanonicalName()))
                        .append(", \"dropped\": ").append(q(col.dropped().type().getCanonicalName()))
                        .append("}");
            }
            out.append(collisions.isEmpty() ? "],\n" : "\n  ],\n");
            out.append("  \"unnamable\": [")
                    .append(unnamable.stream().map(JdkModel::q).collect(Collectors.joining(", ")))
                    .append("],\n");
            out.append("  \"loadFailures\": [")
                    .append(loadFailures.stream().map(JdkModel::q).collect(Collectors.joining(", ")))
                    .append("]\n");
            out.append("}\n");
            return out.toString();
        }

        private long typeCount() {
            return byKey.values().stream().map(Found::type).distinct().count();
        }

        void printSummary(List<String> droppedForSize) {
            System.out.println("JDK " + jdkVersion() + " (" + System.getProperty("java.vendor") + ", "
                    + System.getProperty("java.vendor.version") + ")");
            System.out.println("packages: " + packages.stream().map(Pkg::name).collect(Collectors.joining(", ")));
            if (!droppedForSize.isEmpty()) {
                System.out.println("dropped to fit the size budget: " + String.join(", ", droppedForSize));
            }
            System.out.printf("public types found: %d; modelled types: %d; keys: %d%n",
                    found.size(), typeCount(), byKey.size());
            System.out.println("collisions (" + collisions.size() + "):");
            for (Collision c : collisions) {
                System.out.printf("  %s: kept %s, dropped %s%n",
                        c.key(), c.kept().type().getCanonicalName(), c.dropped().type().getCanonicalName());
            }
            List<String> previews = found.stream().filter(Found::preview)
                    .map(f -> f.type().getCanonicalName()).sorted().toList();
            System.out.println("preview APIs included (" + previews.size() + "): " + String.join(", ", previews));
            System.out.println("referenced types named ? because their simple name means another model type ("
                    + unnamable.size() + "): " + String.join(", ", unnamable));
            System.out.println("load failures (" + loadFailures.size() + ")" + (loadFailures.isEmpty() ? "" : ":"));
            loadFailures.forEach(f -> System.out.println("  " + f));
        }
    }

    /** {@code Map$Entry} is a member type; {@code Map$1} and {@code Map$1Local} are not. */
    private static boolean isMemberName(String local) {
        String[] parts = local.split("\\$", -1);
        for (int i = 1; i < parts.length; i++) {
            if (parts[i].isEmpty() || Character.isDigit(parts[i].charAt(0))) return false;
        }
        return true;
    }

    /** Public, inside public types only, in a package its module exports to everyone. */
    private static boolean isAccessible(Class<?> type) {
        for (Class<?> k = type; k != null; k = k.getEnclosingClass()) {
            if (!Modifier.isPublic(k.getModifiers())) return false;
        }
        return type.getModule().isExported(type.getPackageName());
    }

    private static boolean isPreviewAnnotated(byte[] classFile) {
        ClassModel cm = ClassFile.of().parse(classFile);
        Stream<Annotation> annotations = Stream.concat(
                cm.findAttribute(Attributes.runtimeInvisibleAnnotations()).stream()
                        .flatMap(a -> a.annotations().stream()),
                cm.findAttribute(Attributes.runtimeVisibleAnnotations()).stream()
                        .flatMap(a -> a.annotations().stream()));
        return annotations.anyMatch(a -> a.className().stringValue().equals(PREVIEW_ANNOTATION));
    }

    private static String q(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
                    else out.append(ch);
                }
            }
        }
        return out.append('"').toString();
    }
}
