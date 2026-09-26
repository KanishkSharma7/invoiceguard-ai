let csrfToken = "";
export function setCsrfToken(value: string) {
  csrfToken = value;
}
export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 && path != "/auth/login" && path != "/auth/me")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiFailure(
      body?.error?.message ?? "Could not connect to the server.",
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
