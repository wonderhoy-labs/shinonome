package com.wonderhoylabs.shinonome.server;

final class Log {

    private Log() {
    }

    static void info(String message) {
        System.out.println(message);
    }

    static void error(String message, Throwable error) {
        Throwable cause = error.getCause() != null ? error.getCause() : error;
        System.out.println("ERROR " + message + ": " + cause);
    }
}
