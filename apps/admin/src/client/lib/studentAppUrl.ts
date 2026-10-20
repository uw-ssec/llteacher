const STUDENT_PORT_BY_ADMIN_PORT: Readonly<Record<string, string>> = {
  "2312": "2311",
  "2412": "2411",
};

export function studentAppUrl(
  courseId: string,
  origin = window.location.origin,
): string {
  const url = new URL("/", origin);
  const studentPort = ["localhost", "127.0.0.1"].includes(url.hostname)
    ? STUDENT_PORT_BY_ADMIN_PORT[url.port] : undefined;
  if (studentPort) url.port = studentPort;
  url.searchParams.set("view", "student");
  url.searchParams.set("courseId", courseId);
  return url.toString();
}
