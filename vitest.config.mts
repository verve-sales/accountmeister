import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
