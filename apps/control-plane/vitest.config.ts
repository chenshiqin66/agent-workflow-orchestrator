import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Isolate files so vi.stubGlobal("fetch") in unit tests cannot break
    // the real-network M2 integration test.
    pool: "forks",
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
