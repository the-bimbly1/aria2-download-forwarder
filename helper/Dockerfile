# Container image for the aria2 Download Forwarder helper service.
#
# Based on Microsoft's Playwright image, which already ships Chromium and all of
# its system libraries. Keep the Playwright version here in step with
# requirements.txt. The image is large (~2 GB), mostly because of the browser.
FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy

# ffmpeg lets yt-dlp merge separate video and audio streams when it downloads by itself.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so code-only changes don't bust this layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && playwright install chromium

COPY app.py .

# Defaults; override these (and set HELPER_TOKEN) through env vars or an env file.
ENV DOWNLOAD_DIR=/downloads ARIA2_RPC=http://127.0.0.1:6800/jsonrpc
EXPOSE 6890

# Run through sh so HOST and PORT can be overridden at runtime.
CMD ["sh", "-c", "uvicorn app:app --host ${HOST:-0.0.0.0} --port ${PORT:-6890}"]
