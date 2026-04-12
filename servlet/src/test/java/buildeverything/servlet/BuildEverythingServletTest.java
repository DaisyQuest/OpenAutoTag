package buildeverything.servlet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BuildEverythingServletTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private Server server;
    private int port;
    private HttpClient client;

    @BeforeEach
    void setUp() throws Exception {
        Path repoRoot = Path.of(System.getProperty("buildeverything.repoRoot", "")).toAbsolutePath().normalize();
        if (!Files.exists(repoRoot.resolve("orchestrator").resolve("public").resolve("index.html"))) {
            throw new IOException("Test repo root did not resolve to the project root: " + repoRoot);
        }

        server = BuildEverythingServerLauncher.createServer(0);
        server.start();
        port = ((ServerConnector) server.getConnectors()[0]).getLocalPort();
        client = HttpClient.newHttpClient();
    }

    @AfterEach
    void tearDown() throws Exception {
        if (server != null) {
            server.stop();
        }
    }

    @Test
    void healthEndpointReportsRuntimeRoots() throws Exception {
        HttpResponse<String> response = get("/health");
        JsonNode payload = MAPPER.readTree(response.body());

        assertEquals(200, response.statusCode());
        assertTrue(payload.path("ok").asBoolean());
        assertTrue(payload.path("runtime").path("root").asText().contains("tmp"));
        assertTrue(payload.path("runtime").path("jobsRoot").asText().contains("jobs"));
    }

    @Test
    void workloadsEndpointMatchesNodeCatalog() throws Exception {
        HttpResponse<String> response = get("/workloads");
        JsonNode payload = MAPPER.readTree(response.body());

        assertEquals(200, response.statusCode());
        assertEquals(3, payload.path("workloads").size());
        assertTrue(payload.path("workloads").toString().contains("accessibility-tagging"));
        assertTrue(payload.path("workloads").toString().contains("ssn-redaction"));
        assertTrue(payload.path("workloads").toString().contains("tag-and-ssn-redact"));
    }

    @Test
    void rootServesDashboardHtml() throws Exception {
        HttpResponse<String> response = get("/");

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("content-type").orElse("").contains("text/html"));
        assertTrue(response.body().contains("<!DOCTYPE html>") || response.body().contains("<html"));
    }

    @Test
    void unknownRouteReturnsJson404() throws Exception {
        HttpResponse<String> response = get("/does-not-exist");
        JsonNode payload = MAPPER.readTree(response.body());

        assertEquals(404, response.statusCode());
        assertEquals("Not found", payload.path("error").asText());
    }

    private HttpResponse<String> get(String path) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("http://localhost:" + port + path))
            .GET()
            .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }
}
