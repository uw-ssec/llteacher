const STUDENT_PORT_BY_ADMIN_PORT: Readonly<Record<string, string>> = {
  "2312": "2311",
  "2412": "2411",
};

export function studentAppUrl(
  courseId: string,
  origin = window.location.origin,
): string {
  const url = new URL("/", origin);
  const studentPort = STUDENT_PORT_BY_ADMIN_PORT[url.port];
  if (studentPort) url.port = studentPort;
  url.searchParams.set("view", "student");
  url.searchParams.set("courseId", courseId);
  return url.toString();
}

export function openStudentApp(
  courseId: string,
  assign: (url: string) => void = (url) => window.location.assign(url),
  origin = window.location.origin,
): void {
  assign(studentAppUrl(courseId, origin));
}
