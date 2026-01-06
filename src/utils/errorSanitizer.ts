/**
 * Maximum size for stringified data in logs (100KB)
 * This prevents "Invalid string length" errors when logging
 */
const MAX_LOG_DATA_SIZE = 100 * 1024; // 100KB

/**
 * Maximum depth for nested objects when sanitizing
 */
const MAX_DEPTH = 10;

/**
 * Sanitizes error objects and data for safe logging
 * Prevents "Invalid string length" errors by limiting data size
 *
 * @param data - The data to sanitize
 * @param depth - Current recursion depth (internal use)
 * @returns Sanitized data safe for logging
 */
export function sanitizeForLogging(data: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > MAX_DEPTH) {
    return '[Max depth exceeded]';
  }

  // Handle null and undefined
  if (data === null || data === undefined) {
    return data;
  }

  // Handle primitive types
  if (typeof data === 'boolean' || typeof data === 'number') {
    return data;
  }

  // Handle strings - truncate if too long
  if (typeof data === 'string') {
    const maxStringLength = 10000; // 10KB max for a single string
    if (data.length > maxStringLength) {
      return `${data.substring(0, maxStringLength)}...[truncated ${data.length - maxStringLength} chars]`;
    }
    return data;
  }

  // Handle Error objects - extract only relevant information
  if (data instanceof Error) {
    const errorData: Record<string, unknown> = {
      name: data.name,
      message: data.message,
      stack: data.stack?.substring(0, 5000), // Limit stack trace to 5KB
    };

    // Check for cause property (ES2022 feature, but may exist at runtime)
    // Use 'in' operator for type-safe property check
    if ('cause' in data && data.cause) {
      errorData.cause = sanitizeForLogging(data.cause, depth + 1);
    }

    // Only include additional error properties if they're not too large
    if (Object.keys(data).length > 0) {
      errorData.properties = sanitizeForLogging(
        Object.fromEntries(
          Object.entries(data)
            .filter(([key]) => !['name', 'message', 'stack', 'cause'].includes(key))
            .slice(0, 10) // Limit to first 10 additional properties
        ),
        depth + 1
      );
    }

    return errorData;
  }

  // Handle arrays - limit size and sanitize each element
  if (Array.isArray(data)) {
    const maxArrayLength = 100; // Limit to first 100 items
    if (data.length > maxArrayLength) {
      return [
        ...data.slice(0, maxArrayLength).map(item => sanitizeForLogging(item, depth + 1)),
        `...[${data.length - maxArrayLength} more items]`,
      ];
    }
    return data.map(item => sanitizeForLogging(item, depth + 1));
  }

  // Handle objects
  if (typeof data === 'object') {
    // Handle special objects that might be large
    if (data instanceof Buffer) {
      return `[Buffer: ${data.length} bytes]`;
    }

    if (data instanceof Date) {
      return data.toISOString();
    }

    // Handle plain objects
    const obj = data as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    let keyCount = 0;
    const maxKeys = 50; // Limit to first 50 keys

    for (const [key, value] of Object.entries(obj)) {
      if (keyCount >= maxKeys) {
        sanitized['...'] = `[${Object.keys(obj).length - maxKeys} more keys]`;
        break;
      }

      // Skip functions
      if (typeof value === 'function') {
        continue;
      }

      // Handle response data specially - it's often very large
      if (key === 'data' || key === 'responseData' || key === 'response') {
        sanitized[key] = sanitizeResponseData(value);
      } else {
        sanitized[key] = sanitizeForLogging(value, depth + 1);
      }

      keyCount++;
    }

    return sanitized;
  }

  // For any other type, convert to string (safely)
  try {
    const str = String(data);
    if (str.length > 1000) {
      return `${str.substring(0, 1000)}...[truncated]`;
    }
    return str;
  } catch {
    return '[Unable to stringify]';
  }
}

/**
 * Sanitizes response data from HTTP responses
 * Often contains large HTML/JSON that needs special handling
 *
 * @param responseData - The response data to sanitize
 * @returns Sanitized response data
 */
function sanitizeResponseData(responseData: unknown): unknown {
  if (!responseData) {
    return responseData;
  }

  // If it's a string, check size
  if (typeof responseData === 'string') {
    const maxResponseLength = 5000; // 5KB max for response data
    if (responseData.length > maxResponseLength) {
      return `${responseData.substring(0, maxResponseLength)}...[truncated ${responseData.length - maxResponseLength} chars]`;
    }
    return responseData;
  }

  // If it's an object, sanitize it
  if (typeof responseData === 'object') {
    try {
      const stringified = JSON.stringify(responseData);
      if (stringified.length > 10000) {
        // If it's too large, try to extract just error message or status
        if (typeof responseData === 'object' && responseData !== null) {
          const obj = responseData as Record<string, unknown>;
          const important: Record<string, unknown> = {};

          // Extract common important fields
          if ('message' in obj) important.message = obj.message;
          if ('error' in obj) important.error = obj.error;
          if ('status' in obj) important.status = obj.status;
          if ('statusCode' in obj) important.statusCode = obj.statusCode;

          if (Object.keys(important).length > 0) {
            return {
              ...important,
              _truncated: true,
              _originalSize: stringified.length,
            };
          }
        }

        return `[Response data too large: ${stringified.length} bytes, truncated]`;
      }
      return responseData;
    } catch {
      return '[Unable to serialize response data]';
    }
  }

  return responseData;
}

/**
 * Safely converts data to a loggable format
 * Wraps sanitizeForLogging with additional safety checks
 *
 * @param message - The log message
 * @param data - Optional data to include in the log
 * @returns Sanitized log entry
 */
export function createSafeLogEntry(
  message: string,
  data?: unknown
): { message: string; data?: unknown } {
  try {
    const sanitized = data !== undefined ? sanitizeForLogging(data) : undefined;

    // Final size check - ensure the entire entry isn't too large
    if (sanitized !== undefined) {
      try {
        const testString = JSON.stringify(sanitized);
        if (testString.length > MAX_LOG_DATA_SIZE) {
          return {
            message,
            data: {
              _truncated: true,
              _originalSize: testString.length,
              _message: 'Log data exceeded maximum size and was truncated',
            },
          };
        }
      } catch {
        return {
          message,
          data: '[Unable to serialize log data]',
        };
      }
    }

    return {
      message,
      data: sanitized,
    };
  } catch (error) {
    return {
      message,
      data: `[Error sanitizing log data: ${error instanceof Error ? error.message : 'Unknown error'}]`,
    };
  }
}
