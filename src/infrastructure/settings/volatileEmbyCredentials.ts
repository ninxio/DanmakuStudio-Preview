let volatileEmbyPassword = "";

export function loadVolatileEmbyPassword(): string {
  return volatileEmbyPassword;
}

export function saveVolatileEmbyPassword(password: string): void {
  volatileEmbyPassword = password;
}

export function clearVolatileEmbyCredentials(): void {
  volatileEmbyPassword = "";
}
