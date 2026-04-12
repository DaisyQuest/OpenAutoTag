package buildeverything.servlet;

import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

public final class BuildEverythingServerLauncher {
    private BuildEverythingServerLauncher() {
    }

    public static Server createServer(int port) {
        Server server = new Server(port);
        ServletContextHandler context = new ServletContextHandler(ServletContextHandler.SESSIONS);
        context.setContextPath("/");
        context.addServlet(BuildEverythingServlet.class, "/*");
        server.setHandler(context);
        return server;
    }

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getProperty("buildeverything.port", "3000"));
        Server server = createServer(port);
        server.start();

        int actualPort = port;
        if (server.getConnectors().length > 0 && server.getConnectors()[0] instanceof ServerConnector connector) {
            actualPort = connector.getLocalPort();
        }

        System.out.printf("Servlet server listening on http://localhost:%d%n", actualPort);
        server.join();
    }
}
