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
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        ...options.headers,
      },
    });
  } catch {
    throw new ApiFailure(
      "Unable to reach the server. Check your connection and try again.",
      0,
    );
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401 && path != "/auth/login" && path != "/auth/me")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiFailure(
      body?.error?.message ?? "Could not connect to the server.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json();
  } catch {
    throw new ApiFailure(
      "The server returned an unreadable response. Please try again.",
      response.status,
    );
  }
}
