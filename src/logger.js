export function createLogger(defaultFields = {}) {
  function write(level, message, fields = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...defaultFields,
      ...fields,
    };

    const line = `${JSON.stringify(entry)}\n`;

    if (level === "error") {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }

  return {
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    },
  };
}
