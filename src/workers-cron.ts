// CF weekdays are 1 (Sunday) through 7 (Saturday). Reject unsupported
// syntax before resource writes; do not silently apply Unix cron semantics.
export function validNativeCron(cron: string): boolean {
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [1, 7],
  ];
  const fields = cron.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    fields.every((field, index) =>
      field.split(",").every((part) => {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (
          !match ||
          (match[2] !== undefined &&
            (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1))
        )
          return false;
        // A singleton/step has differing cron dialect semantics; ranges are explicit.
        if (
          match[2] !== undefined &&
          match[1] !== "*" &&
          !match[1].includes("-")
        )
          return false;
        if (match[1] === "*") return true;
        const [start, end = start] = match[1].split("-").map(Number);
        return (
          start >= ranges[index][0] && end <= ranges[index][1] && start <= end
        );
      }),
    )
  );
}
