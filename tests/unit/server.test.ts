import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";

describe("Server Entry Point & Health Endpoints", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Ensure test environment has a valid key for initialization
    process.env.TINYFISH_API_KEY = "tf_test_server_suite_key_123456";
    process.env.NODE_ENV = "test";

    const app = createServer();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("serves the /health endpoint with service metadata", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.service).toBe("shadowtwin");
    expect(data.environment).toBe("test");
    expect(data.tinyfishConfigured).toBe(true);
    expect(data.timestamp).toBeDefined();
  });

  it("serves redacted system diagnostics from /api/diagnostics", async () => {
    const res = await fetch(`${baseUrl}/api/diagnostics`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.environment).toBe("test");
    // Ensure the raw secret key is never returned over HTTP
    expect(data.tinyFishKeyStatus).not.toBe("tf_test_server_suite_key_123456");
    expect(data.tinyFishKeyStatus).toBe("tf_...456");
    expect(Array.isArray(data.allowedTargetDomains)).toBe(true);
  });
});

