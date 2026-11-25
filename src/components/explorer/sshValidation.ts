export interface SshFormInput {
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: string;
  sshPassword: string;
  sshKeyPath: string;
  /** Database host and port as the SSH server sees them. */
  host: string;
  port: string;
}

/** A TCP port typed into the form, or null when it isn't one. */
export function parsePort(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Problems to fix before the SSH tunnel test can run, one message per field.
 * Catches what used to fail later or silently (a non-numeric port became 22).
 */
export function validateSshForm(f: SshFormInput): string[] {
  const problems: string[] = [];
  const host = f.sshHost.trim();
  if (!host) problems.push("SSH host is required.");
  else if (/^[a-z]+:\/\//i.test(host)) problems.push("SSH host must be a host name or address, without ssh:// or another scheme.");
  else if (host.includes("@")) problems.push("Put the user name in SSH Username, not in SSH host (user@host).");
  else if (/\s/.test(host)) problems.push("SSH host must not contain spaces.");
  else if (/:\d+$/.test(host) && !host.startsWith("[") && host.split(":").length === 2) problems.push("Put the port in SSH Port, not in SSH host (host:port).");

  if (parsePort(f.sshPort) === null) problems.push("SSH port must be a number from 1 to 65535.");

  const user = f.sshUsername.trim();
  if (!user) problems.push("SSH username is required.");
  else if (/\s/.test(user)) problems.push("SSH username must not contain spaces.");

  if (f.sshAuthMethod === "key") {
    if (!f.sshKeyPath.trim()) problems.push("Choose the private key file (Browse…).");
    else if (f.sshKeyPath.trim().endsWith(".pub")) problems.push("That is the public key (.pub). Choose the private key, the same name without .pub.");
  } else if (!f.sshPassword) {
    problems.push("Enter the SSH password.");
  }

  if (f.host.trim() && parsePort(f.port) === null) problems.push("Database port must be a number from 1 to 65535.");
  return problems;
}
