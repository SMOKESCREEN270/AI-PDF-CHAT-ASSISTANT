"""Shared synchronization for the legacy google-generativeai SDK.

google-generativeai 0.8.2 authenticates through module-global state rather than
an API-key-scoped client. All configure-and-request sequences must use this
lock to prevent concurrent requests from crossing API keys.
"""
from threading import Lock


genai_lock = Lock()