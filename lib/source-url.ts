const KEY = "vectorview:source-url";

export function getSourceUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(KEY) ?? "";
}

export function setSourceUrl(url: string) {
  if (typeof window === "undefined") return;
  const trimmed = url.trim();
  if (trimmed) {
    window.localStorage.setItem(KEY, trimmed);
  } else {
    window.localStorage.removeItem(KEY);
  }
}
