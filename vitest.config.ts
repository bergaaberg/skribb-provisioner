import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Library tests at tests/**, dispatcher tests at dispatcher/tests/**.
		include: ["tests/**/*.test.ts", "dispatcher/tests/**/*.test.ts"],
		environment: "node",
	},
});
