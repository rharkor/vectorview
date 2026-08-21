const KEY = "vectorview:gateway-token";
const EVENT = "vectorview:token-changed";

export function getGatewayToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function setGatewayToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(KEY, token);
  } else {
    window.localStorage.removeItem(KEY);
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onTokenChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
