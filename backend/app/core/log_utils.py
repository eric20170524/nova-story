import json
from typing import Any, Dict, List, Union

def truncate_log_content(content: Any, max_length: int = 500) -> Any:
    """
    Recursively truncates strings in the content (dict, list, or str) to max_length.
    Useful for logging large JSON objects or long text prompts.
    """
    if isinstance(content, str):
        if len(content) > max_length:
            return content[:max_length] + f"...(truncated, {len(content) - max_length} more chars)"
        return content
    elif isinstance(content, dict):
        return {k: truncate_log_content(v, max_length) for k, v in content.items()}
    elif isinstance(content, list):
        return [truncate_log_content(item, max_length) for item in content]
    elif hasattr(content, "dict"):  # Handle Pydantic models (v1)
        return truncate_log_content(content.dict(), max_length)
    elif hasattr(content, "model_dump"):  # Handle Pydantic models (v2)
        return truncate_log_content(content.model_dump(), max_length)
    else:
        return content

def format_log_message(prefix: str, content: Any, max_length: int = 500) -> str:
    """
    Formats a log message with truncated content.
    """
    truncated = truncate_log_content(content, max_length)
    if isinstance(truncated, (dict, list)):
        try:
            return f"{prefix}: {json.dumps(truncated, ensure_ascii=False)}"
        except TypeError:
            return f"{prefix}: {str(truncated)}"
    return f"{prefix}: {truncated}"
