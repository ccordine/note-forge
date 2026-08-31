import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const composeSource = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
const dockerfileSource = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const deploySource = readFileSync(new URL("../scripts/deploy-worknet.sh", import.meta.url), "utf8");

describe("WorkNet deployment contract", () => {
  it("attaches NoteForge to the permanently external WorkNet network", () => {
    expect(composeSource).toMatch(/services:\s+[\s\S]*app:[\s\S]*networks:\s+- worknet/);
    expect(composeSource).toMatch(/networks:\s+[\s\S]*worknet:\s+[\s\S]*external: true\s+[\s\S]*name: worknet_net/);
    expect(dockerfileSource).toContain('com.cordine.worknet.required-network="worknet_net"');
  });

  it("pins deployment to the owning context and refuses a missing network", () => {
    expect(deploySource).toContain('deployment_context="default"');
    expect(deploySource).toContain('external_network="worknet_net"');
    expect(deploySource).toContain('network inspect "$external_network"');
    expect(deploySource).not.toMatch(/network\s+create/);
  });
});
