import { describe, expect, it } from "vitest";
import {
	resolveTenant,
	type HostResolverConfig,
} from "../src/host-resolver.js";

const config: HostResolverConfig = {
	cmsBaseDomain: "cms.skribb.no",
	scriptPrefix: "skribb-cms-",
};

describe("resolveTenant — happy path", () => {
	it("extracts the handle from a tenant subdomain", () => {
		expect(resolveTenant(config, "alice.cms.skribb.no")).toEqual({
			handle: "alice",
			scriptName: "skribb-cms-alice",
		});
	});

	it("is case-insensitive on the host", () => {
		expect(resolveTenant(config, "Alice.CMS.SKRIBB.no")).toEqual({
			handle: "alice",
			scriptName: "skribb-cms-alice",
		});
	});

	it("strips a port from the host", () => {
		expect(resolveTenant(config, "alice.cms.skribb.no:4321")).toEqual({
			handle: "alice",
			scriptName: "skribb-cms-alice",
		});
	});

	it("accepts digits and hyphens in the handle", () => {
		expect(resolveTenant(config, "alice-99.cms.skribb.no")?.handle).toBe(
			"alice-99",
		);
	});
});

describe("resolveTenant — null cases", () => {
	it("returns null for the apex itself", () => {
		expect(resolveTenant(config, "cms.skribb.no")).toBeNull();
	});

	it("returns null when the host doesn't end with the base domain", () => {
		expect(resolveTenant(config, "alice.example.com")).toBeNull();
		expect(resolveTenant(config, "alice.skribb.no")).toBeNull();
	});

	it("returns null for multi-label subdomains", () => {
		// `staging.alice.cms.skribb.no` shouldn't accidentally route to
		// a tenant called `staging.alice` — we want strict single-label.
		expect(resolveTenant(config, "staging.alice.cms.skribb.no")).toBeNull();
	});

	it("returns null for handles with disallowed characters", () => {
		expect(resolveTenant(config, "ALICE!.cms.skribb.no")).toBeNull();
		expect(resolveTenant(config, "alice_underscore.cms.skribb.no")).toBeNull();
	});

	it("returns null for handles starting with a hyphen", () => {
		// Reserved by DNS conventions; also a common attack-surface paper-cut.
		expect(resolveTenant(config, "-leading.cms.skribb.no")).toBeNull();
	});

	it("returns null for the empty string", () => {
		expect(resolveTenant(config, "")).toBeNull();
	});
});
