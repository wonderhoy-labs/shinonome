# The desktop server runs in a process of its own, started through app_process by class name from start.sh, and it
# calls Android's hidden APIs by reflection. None of it may be renamed or removed.
-keep class com.wonderhoylabs.shinonome.server.** { *; }

# Shizuku creates ShellService by name, through its constructor, in its own process.
-keep class com.wonderhoylabs.shinonome.ShellService { *; }
