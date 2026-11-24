import { describe, expect, it } from "vitest";
import { parsePort, validateSshForm, type SshFormInput } from "./sshValidation";

const ok: SshFormInput = {
  sshHost: "bastion.example.com", sshPort: "22", sshUsername: "deploy", sshAuthMethod: "key",
  sshPassword: "", sshKeyPath: "/home/u/.ssh/id_ed25519", host: "10.0.0.5", port: "5432",
};

describe("parsePort", () => {
  it("accepts 1–65535 only", () => {
    expect(parsePort("22")).toBe(22);
    expect(parsePort(" 5432 ")).toBe(5432);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("22a")).toBeNull();
    expect(parsePort("")).toBeNull();
  });
});

describe("validateSshForm", () => {
  it("passes a complete form", () => {
    expect(validateSshForm(ok)).toEqual([]);
    expect(validateSshForm({ ...ok, sshAuthMethod: "password", sshKeyPath: "", sshPassword: "s3cret" })).toEqual([]);
    expect(validateSshForm({ ...ok, sshHost: "[2001:db8::1]" })).toEqual([]);
  });

  it("catches the usual mistakes, one message each", () => {
    expect(validateSshForm({ ...ok, sshHost: "" })).toEqual(["SSH host is required."]);
    expect(validateSshForm({ ...ok, sshHost: "deploy@bastion" })[0]).toMatch(/SSH Username/);
    expect(validateSshForm({ ...ok, sshHost: "ssh://bastion" })[0]).toMatch(/scheme/);
    expect(validateSshForm({ ...ok, sshHost: "bastion:2222" })[0]).toMatch(/SSH Port/);
    expect(validateSshForm({ ...ok, sshPort: "abc" })).toEqual(["SSH port must be a number from 1 to 65535."]);
    expect(validateSshForm({ ...ok, sshUsername: " " })).toEqual(["SSH username is required."]);
    expect(validateSshForm({ ...ok, sshKeyPath: "" })[0]).toMatch(/private key file/);
    expect(validateSshForm({ ...ok, sshKeyPath: "/home/u/.ssh/id_ed25519.pub" })[0]).toMatch(/public key/);
    expect(validateSshForm({ ...ok, sshAuthMethod: "password", sshPassword: "" })).toEqual(["Enter the SSH password."]);
    expect(validateSshForm({ ...ok, port: "99999" })).toEqual(["Database port must be a number from 1 to 65535."]);
  });
});
