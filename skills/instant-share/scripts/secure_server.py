#!/usr/bin/env python3
"""
Secure artifact server with auth, build status, admin panel, and auto-expire.
Supports global registry for multi-artifact admin view.

Design: Clean, professional. No emojis, no purple, no gradients.
"""

import http.server
import socketserver
import secrets
import sys
import os
import re
import json
import hashlib
import urllib.parse
import mimetypes
import threading
import time
import fcntl
import signal
from pathlib import Path
from datetime import datetime, timedelta
from collections import deque

# Admin password is read from the environment, never hardcoded. Set
# INSTANT_SHARE_ADMIN_PASSWORD (the daemon injects it from config.toml's
# [instant_share].admin_password). If unset, admin login is disabled.
ADMIN_PASSWORD = os.environ.get('INSTANT_SHARE_ADMIN_PASSWORD', '')
ADMIN_PASSWORD_HASH = hashlib.sha256(ADMIN_PASSWORD.encode()).hexdigest() if ADMIN_PASSWORD else None

# Config/state directory. The daemon sets INSTANT_SHARE_CONFIG_DIR to
# <data_dir>/instant-share (see src/claude/mcp-config.ts). The fallback here
# anchors to this skill's own directory so the scripts also work standalone.
_CONFIG_FALLBACK = Path(__file__).resolve().parent.parent / '.config'
CONFIG_DIR = Path(os.environ.get('INSTANT_SHARE_CONFIG_DIR', _CONFIG_FALLBACK))
REGISTRY_FILE = CONFIG_DIR / 'artifact_registry.json'

REQUEST_LOG = deque(maxlen=100)

SERVER_STATE = {
    'started_at': None,
    'expire_at': None,
    'expire_minutes': None,
    'killed': False,
    'request_count': 0,
    'artifact_id': None,
    'pid': os.getpid()
}

# Requests are served on threads (see ThreadedHTTPServer), so the append-only
# callback log needs one writer at a time or two simultaneous taps can interleave
# mid-line and produce a JSON object nobody can parse.
CALLBACK_LOCK = threading.Lock()


def load_registry():
    """Load global artifact registry."""
    try:
        if REGISTRY_FILE.exists():
            with open(REGISTRY_FILE, 'r') as f:
                return json.load(f)
    except:
        pass
    return {'artifacts': {}}


def save_registry(registry):
    """Save global artifact registry with file locking."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with open(REGISTRY_FILE, 'w') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            json.dump(registry, f, indent=2)
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    except:
        pass


def register_artifact(artifact_id, info):
    """Register this artifact in the global registry."""
    registry = load_registry()
    registry['artifacts'][artifact_id] = info
    save_registry(registry)


def unregister_artifact(artifact_id):
    """Remove this artifact from the global registry."""
    registry = load_registry()
    if artifact_id in registry['artifacts']:
        del registry['artifacts'][artifact_id]
        save_registry(registry)


def get_all_artifacts():
    """Get all registered artifacts, filtering out dead ones."""
    registry = load_registry()
    live_artifacts = {}
    changed = False
    
    for aid, info in registry.get('artifacts', {}).items():
        pid = info.get('pid')
        if pid:
            try:
                os.kill(pid, 0)  # Check if process is alive
                live_artifacts[aid] = info
            except ProcessLookupError:
                changed = True  # Process is dead, skip it
        else:
            live_artifacts[aid] = info
    
    if changed:
        registry['artifacts'] = live_artifacts
        save_registry(registry)
    
    return live_artifacts


def kill_artifact_by_id(target_id):
    """Kill another artifact by sending SIGTERM to its process."""
    artifacts = get_all_artifacts()
    if target_id in artifacts:
        pid = artifacts[target_id].get('pid')
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
                return True
            except:
                pass
    return False


# Clean loading page - no emojis, no gradients
LOADING_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="2">
    <title>Building...</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fafafa;
            color: #111;
            padding: 24px;
        }}
        .container {{ text-align: center; max-width: 400px; }}
        .spinner {{
            width: 40px;
            height: 40px;
            border: 3px solid #e0e0e0;
            border-top-color: #111;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 24px;
        }}
        @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
        h1 {{ font-size: 20px; font-weight: 600; margin-bottom: 8px; }}
        p {{ color: #666; font-size: 14px; margin-bottom: 4px; }}
        .status {{
            margin-top: 24px;
            padding: 16px;
            background: #fff;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            font-size: 13px;
            color: #666;
        }}
        .status div {{ padding: 4px 0; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>Building Artifact</h1>
        <p>Content is being prepared.</p>
        <p>This page refreshes automatically.</p>
        <div class="status">
            <div>Status: {status}</div>
            <div>Started: {started}</div>
        </div>
    </div>
</body>
</html>'''

# Admin panel with multi-artifact support
ADMIN_PANEL = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #fafafa;
            color: #111;
            padding: 24px;
            min-height: 100vh;
        }}
        .container {{ max-width: 700px; margin: 0 auto; }}
        h1 {{ font-size: 24px; font-weight: 600; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e0e0e0; }}
        .card {{
            background: #fff;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            padding: 20px;
            margin-bottom: 16px;
        }}
        .card h2 {{ font-size: 14px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px; }}
        .row {{ display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }}
        .row:last-child {{ border-bottom: none; }}
        .label {{ color: #666; }}
        .value {{ font-weight: 500; }}
        button {{
            background: #111;
            color: #fff;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-right: 8px;
            margin-bottom: 8px;
        }}
        button:hover {{ background: #333; }}
        button.danger {{ background: #dc2626; }}
        button.danger:hover {{ background: #b91c1c; }}
        button.small {{ padding: 6px 12px; font-size: 12px; }}
        input {{
            padding: 10px;
            border: 1px solid #e0e0e0;
            border-radius: 4px;
            width: 80px;
            margin-right: 8px;
        }}
        .log {{
            background: #f5f5f5;
            padding: 12px;
            border-radius: 4px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 12px;
            max-height: 200px;
            overflow-y: auto;
        }}
        .log-entry {{ padding: 3px 0; border-bottom: 1px solid #e8e8e8; }}
        .log-time {{ color: #999; }}
        .log-path {{ color: #2563eb; }}
        .log-ok {{ color: #16a34a; }}
        .log-err {{ color: #dc2626; }}
        .warning {{ background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 4px; margin-bottom: 16px; color: #991b1b; }}
        .artifact-row {{
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px;
            border-bottom: 1px solid #f0f0f0;
            gap: 12px;
        }}
        .artifact-row:last-child {{ border-bottom: none; }}
        .artifact-info {{ flex: 1; min-width: 0; }}
        .artifact-name {{ font-weight: 600; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
        .artifact-meta {{ font-size: 12px; color: #666; }}
        .artifact-current {{ background: #f0fdf4; border-left: 3px solid #16a34a; }}
        .badge {{ display: inline-block; background: #e0e0e0; color: #666; font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 6px; }}
        .badge.current {{ background: #dcfce7; color: #166534; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>Admin Panel</h1>
        
        {killed_warning}
        
        <div class="card">
            <h2>All Running Artifacts</h2>
            {all_artifacts}
        </div>
        
        <div class="card">
            <h2>Current Artifact</h2>
            <div class="row"><span class="label">Name</span><span class="value">{artifact_name}</span></div>
            <div class="row"><span class="label">Purpose</span><span class="value">{artifact_purpose}</span></div>
            <div class="row"><span class="label">Created</span><span class="value">{created_at}</span></div>
            <div class="row"><span class="label">Status</span><span class="value">{server_status}</span></div>
            <div class="row"><span class="label">Requests</span><span class="value">{request_count}</span></div>
            <div class="row"><span class="label">Expires</span><span class="value">{expire_at}</span></div>
        </div>
        
        <div class="card">
            <h2>Controls</h2>
            <form method="POST" action="/admin/?key={token}&admin_session={admin_session}" style="display: inline;">
                <input type="hidden" name="action" value="kill">
                <button type="submit" class="danger">Stop This Artifact</button>
            </form>
            <form method="POST" action="/admin/?key={token}&admin_session={admin_session}" style="display: inline;">
                <input type="hidden" name="action" value="set_expire">
                <input type="number" name="minutes" placeholder="Min" min="1" max="1440">
                <button type="submit">Set Timer</button>
            </form>
        </div>
        
        <div class="card">
            <h2>Request Log</h2>
            <div class="log">{log_entries}</div>
        </div>
    </div>
</body>
</html>'''

ADMIN_LOGIN = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            background: #fafafa;
        }}
        .login {{
            background: #fff;
            padding: 32px;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            width: 300px;
        }}
        h1 {{ font-size: 18px; margin-bottom: 20px; text-align: center; }}
        input {{
            width: 100%;
            padding: 12px;
            margin-bottom: 16px;
            border: 1px solid #e0e0e0;
            border-radius: 4px;
        }}
        button {{
            width: 100%;
            padding: 12px;
            background: #111;
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }}
        .error {{ color: #dc2626; text-align: center; margin-bottom: 16px; font-size: 14px; }}
    </style>
</head>
<body>
    <div class="login">
        <h1>Admin Access</h1>
        {error}
        <form method="POST" action="/admin/?key={token}">
            <input type="hidden" name="action" value="login">
            <input type="password" name="password" placeholder="Password" autofocus>
            <button type="submit">Login</button>
        </form>
    </div>
</body>
</html>'''

KILLED_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unavailable</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            background: #fafafa;
            text-align: center;
            padding: 24px;
        }
        h1 { font-size: 20px; margin-bottom: 8px; }
        p { color: #666; }
    </style>
</head>
<body>
    <div>
        <h1>Artifact Unavailable</h1>
        <p>This artifact has been stopped.</p>
    </div>
</body>
</html>'''


class SecureArtifactHandler(http.server.BaseHTTPRequestHandler):
    AUTH_TOKEN = None
    ARTIFACT_ROOT = None
    ARTIFACT_ID = None
    IS_DIRECTORY = False
    FILE_CONTENT = None
    MANIFEST = {}
    ADMIN_SESSIONS = set()
    
    def log_message(self, format, *args):
        pass
    
    def log_request_entry(self, path, status):
        entry = {
            'time': datetime.utcnow().strftime("%H:%M:%S"),
            'path': path[:50],
            'status': status,
            'ip': self.client_address[0]
        }
        REQUEST_LOG.append(entry)
        SERVER_STATE['request_count'] += 1
    
    def send_html(self, code, html):
        content = html.encode('utf-8')
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", len(content))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)
    
    def send_json(self, code, payload):
        content = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(content))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def validate_token(self, query):
        token = query.get('key', [None])[0] or query.get('token', [None])[0]
        return token and secrets.compare_digest(token, self.AUTH_TOKEN)
    
    def is_admin_authenticated(self, query):
        session = query.get('admin_session', [None])[0]
        return session and session in self.ADMIN_SESSIONS
    
    def is_building(self):
        if not self.IS_DIRECTORY:
            return False
        status_file = self.ARTIFACT_ROOT / '_status'
        if not status_file.exists():
            return False
        return status_file.read_text().strip().lower() in ('building', 'pending')
    
    def format_all_artifacts(self, query):
        """Generate HTML for all running artifacts."""
        artifacts = get_all_artifacts()
        current_id = SERVER_STATE.get('artifact_id')
        session = query.get('admin_session', [''])[0]
        
        if not artifacts:
            return '<div style="color: #666; padding: 12px;">No artifacts running</div>'
        
        rows = []
        for aid, info in artifacts.items():
            is_current = aid == current_id
            row_class = 'artifact-row artifact-current' if is_current else 'artifact-row'
            badge = '<span class="badge current">current</span>' if is_current else ''
            
            name = info.get('name', 'Unnamed')[:30]
            started = info.get('started', 'Unknown')
            expire = info.get('expire_minutes', '?')
            
            kill_form = ''
            if not is_current:
                kill_form = f'''
                <form method="POST" action="/admin/?key={self.AUTH_TOKEN}&admin_session={session}" style="display:inline;">
                    <input type="hidden" name="action" value="kill_other">
                    <input type="hidden" name="target_id" value="{aid}">
                    <button type="submit" class="danger small">Stop</button>
                </form>'''
            
            rows.append(f'''
            <div class="{row_class}">
                <div class="artifact-info">
                    <div class="artifact-name">{name}{badge}</div>
                    <div class="artifact-meta">Started: {started} | Expires: {expire}m</div>
                </div>
                {kill_form}
            </div>''')
        
        return '\n'.join(rows)
    
    def handle_admin(self, query):
        if SERVER_STATE.get('killed'):
            admin_session = query.get('admin_session', [''])[0]
            self.send_html(200, ADMIN_PANEL.format(
                killed_warning='<div class="warning">Artifact has been stopped. Restart server to re-enable.</div>',
                all_artifacts=self.format_all_artifacts(query),
                artifact_name=self.MANIFEST.get('name', 'Unknown'),
                artifact_purpose=self.MANIFEST.get('purpose', 'Not specified'),
                created_at=self.MANIFEST.get('created_at', 'Unknown'),
                server_started=SERVER_STATE.get('started_at', 'Unknown'),
                request_count=SERVER_STATE.get('request_count', 0),
                expire_at=str(SERVER_STATE.get('expire_at', 'Never')),
                server_status='Stopped',
                token=self.AUTH_TOKEN,
                admin_session=admin_session,
                log_entries=self.format_log_entries()
            ))
            return
        
        if not self.is_admin_authenticated(query):
            self.send_html(200, ADMIN_LOGIN.format(token=self.AUTH_TOKEN, error=''))
            return
        
        expire_str = 'Never'
        if SERVER_STATE.get('expire_at'):
            expire_str = SERVER_STATE['expire_at'].strftime("%H:%M:%S UTC")
        
        admin_session = query.get('admin_session', [''])[0]
        self.send_html(200, ADMIN_PANEL.format(
            killed_warning='',
            all_artifacts=self.format_all_artifacts(query),
            artifact_name=self.MANIFEST.get('name', 'Unknown'),
            artifact_purpose=self.MANIFEST.get('purpose', 'Not specified'),
            created_at=self.MANIFEST.get('created_at', 'Unknown'),
            server_started=SERVER_STATE.get('started_at', 'Unknown'),
            request_count=SERVER_STATE.get('request_count', 0),
            expire_at=expire_str,
            server_status='Active',
            token=self.AUTH_TOKEN,
            admin_session=admin_session,
            log_entries=self.format_log_entries()
        ))
    
    def format_log_entries(self):
        entries = []
        for entry in reversed(list(REQUEST_LOG)):
            status_class = 'log-err' if entry['status'] >= 400 else 'log-ok'
            entries.append(f'<div class="log-entry"><span class="log-time">{entry["time"]}</span> '
                          f'<span class="log-path">{entry["path"]}</span> '
                          f'<span class="{status_class}">{entry["status"]}</span></div>')
        return '\n'.join(entries) if entries else '<div class="log-entry">No requests yet</div>'
    
    def handle_admin_post(self, query, post_data):
        action = post_data.get('action', [''])[0]
        
        if action == 'login':
            password = post_data.get('password', [''])[0]
            if ADMIN_PASSWORD_HASH and hashlib.sha256(password.encode()).hexdigest() == ADMIN_PASSWORD_HASH:
                session_id = secrets.token_urlsafe(16)
                self.ADMIN_SESSIONS.add(session_id)
                self.send_response(302)
                self.send_header("Location", f"/admin/?key={self.AUTH_TOKEN}&admin_session={session_id}")
                self.end_headers()
            else:
                self.send_html(200, ADMIN_LOGIN.format(token=self.AUTH_TOKEN, error='<div class="error">Invalid password</div>'))
            return
        
        if not self.is_admin_authenticated(query):
            self.send_html(403, "Forbidden")
            return
        
        if action == 'kill':
            SERVER_STATE['killed'] = True
            unregister_artifact(SERVER_STATE.get('artifact_id'))
            self.update_manifest({'status': 'killed', 'killed_at': datetime.utcnow().isoformat()})
            # Send confirmation page before shutting down
            self.send_html(200, '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Artifact Stopped</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            background: #fafafa;
            text-align: center;
            padding: 24px;
        }
        .container { max-width: 400px; }
        h1 { font-size: 20px; margin-bottom: 12px; color: #16a34a; }
        p { color: #666; margin-bottom: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Artifact Stopped</h1>
        <p>The artifact has been stopped successfully.</p>
        <p>The server is shutting down.</p>
    </div>
</body>
</html>''')
            # Actually stop the server after a short delay (let the response complete)
            def shutdown_server():
                time.sleep(0.5)
                self.server.shutdown()
            threading.Thread(target=shutdown_server, daemon=True).start()
            return
        elif action == 'kill_other':
            target_id = post_data.get('target_id', [''])[0]
            if target_id:
                kill_artifact_by_id(target_id)
        elif action == 'set_expire':
            minutes = int(post_data.get('minutes', [30])[0])
            SERVER_STATE['expire_at'] = datetime.utcnow() + timedelta(minutes=minutes)
            SERVER_STATE['expire_minutes'] = minutes
            self.update_manifest({'expire_minutes': minutes})
            # Update registry
            update_registry_entry(SERVER_STATE.get('artifact_id'), {'expire_minutes': minutes})

        session = query.get('admin_session', [''])[0]
        self.send_response(302)
        self.send_header("Location", f"/admin/?key={self.AUTH_TOKEN}&admin_session={session}")
        self.end_headers()
    
    def update_manifest(self, updates):
        manifest_path = self.ARTIFACT_ROOT / 'artifact.json' if self.IS_DIRECTORY else self.ARTIFACT_ROOT.parent / 'artifact.json'
        try:
            self.MANIFEST.update(updates)
            self.MANIFEST['updated_at'] = datetime.utcnow().isoformat()
            with open(manifest_path, 'w') as f:
                json.dump(self.MANIFEST, f, indent=2)
        except:
            pass
    
    def sanitize_path(self, path):
        path = path.lstrip('/')
        if '..' in path or '\\' in path:
            return None
        if self.ARTIFACT_ID and path.startswith(self.ARTIFACT_ID):
            path = path[len(self.ARTIFACT_ID):].lstrip('/')
        if path.startswith('_') or path == 'artifact.json':
            return None
        if not path or path == 'index.html':
            target = self.ARTIFACT_ROOT / 'index.html' if self.IS_DIRECTORY else self.ARTIFACT_ROOT
        else:
            target = self.ARTIFACT_ROOT / path
        try:
            resolved = target.resolve()
            if not str(resolved).startswith(str(self.ARTIFACT_ROOT.resolve())):
                return None
            return resolved
        except:
            return None
    
    def wrap_for_mobile(self, content, content_type):
        if 'text/html' not in content_type:
            return content
        try:
            html = content.decode('utf-8')
        except:
            return content
        
        modified = False
        
        # Inject viewport if missing
        if 'viewport' not in html.lower():
            viewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
            if '<head' in html.lower():
                html = re.sub(r'(<head[^>]*>)', r'\1\n' + viewport, html, flags=re.IGNORECASE)
                modified = True
        
        # Always inject admin footer before </body> if not already present
        if '</body>' in html.lower() and 'id="instant-share-admin"' not in html:
            admin_url = f"/admin/?key={self.AUTH_TOKEN}"
            admin_footer = (
                '<div id="instant-share-admin" style="position:fixed;bottom:0;left:0;right:0;'
                'background:rgba(0,0,0,0.85);padding:6px 16px;display:flex;align-items:center;'
                'justify-content:space-between;font-family:-apple-system,sans-serif;font-size:11px;'
                'color:#888;z-index:99999;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);">'
                '<span style="display:flex;align-items:center;gap:6px;">'
                '<span style="width:6px;height:6px;border-radius:50%;background:#00e701;display:inline-block;"></span>'
                'Instant Share — Live</span>'
                f'<a href="{admin_url}" style="color:#00e701;text-decoration:none;font-weight:600;'
                'padding:3px 10px;border:1px solid #00e701;border-radius:3px;transition:all 0.15s;"'
                ' onmouseover="this.style.background=\'#00e701\';this.style.color=\'#000\'"'
                ' onmouseout="this.style.background=\'transparent\';this.style.color=\'#00e701\'"'
                '>Admin Panel</a></div>'
            )
            html = re.sub(r'</body>', admin_footer + '</body>', html, flags=re.IGNORECASE)
            modified = True
        
        return html.encode('utf-8')
    
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        
        if not self.validate_token(query):
            self.log_request_entry(parsed.path, 403)
            self.send_html(403, "<html><body><h1>403 Forbidden</h1><p>Invalid or missing access token</p></body></html>")
            return
        
        if SERVER_STATE.get('expire_at') and datetime.utcnow() > SERVER_STATE['expire_at']:
            SERVER_STATE['killed'] = True
            unregister_artifact(SERVER_STATE.get('artifact_id'))
        
        if parsed.path.rstrip('/') == '/callbacks':
            self.handle_callbacks_read(query)
            return

        if parsed.path.startswith('/admin'):
            self.log_request_entry('/admin', 200)
            self.handle_admin(query)
            return

        if SERVER_STATE.get('killed'):
            self.log_request_entry(parsed.path, 410)
            self.send_html(410, KILLED_PAGE)
            return
        
        if self.is_building():
            self.log_request_entry(parsed.path, 200)
            self.send_html(200, LOADING_PAGE.format(
                status='Building',
                started=SERVER_STATE.get('started_at', 'Unknown')
            ))
            return
        
        if not self.IS_DIRECTORY:
            self.log_request_entry('/', 200)
            content = self.wrap_for_mobile(self.FILE_CONTENT, 'text/html')
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", len(content))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
            return
        
        file_path = self.sanitize_path(parsed.path)
        if file_path is None:
            self.log_request_entry(parsed.path, 403)
            self.send_html(403, "<html><body><h1>403 Forbidden</h1></body></html>")
            return
        
        if not file_path.exists():
            self.log_request_entry(parsed.path, 404)
            self.send_html(404, "<html><body><h1>404 Not Found</h1></body></html>")
            return
        
        if file_path.is_dir():
            index = file_path / 'index.html'
            if index.exists():
                file_path = index
            else:
                self.log_request_entry(parsed.path, 403)
                self.send_html(403, "<html><body><h1>403 Forbidden</h1></body></html>")
                return
        
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            content_type, _ = mimetypes.guess_type(str(file_path))
            content_type = content_type or 'application/octet-stream'
            if 'text/html' in content_type:
                content = self.wrap_for_mobile(content, content_type)
            self.log_request_entry(parsed.path, 200)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(content))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)
        except:
            self.log_request_entry(parsed.path, 500)
            self.send_html(500, "<html><body><h1>500 Internal Server Error</h1></body></html>")
    
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        
        if not self.validate_token(query):
            self.send_html(403, "Forbidden")
            return
        
        # Photos are handled before the 64KB read: they are megabytes of binary
        # and would be truncated and mangled by the JSON path below.
        if parsed.path.rstrip('/') == '/upload':
            self.handle_upload(query)
            return

        content_length = min(int(self.headers.get('Content-Length', 0)), 64 * 1024)
        post_body = self.rfile.read(content_length).decode('utf-8', 'replace')

        if parsed.path.rstrip('/') == '/callback':
            self.handle_callback(post_body)
            return

        post_data = urllib.parse.parse_qs(post_body)

        if parsed.path.startswith('/admin'):
            self.handle_admin_post(query, post_data)
            return

        self.send_html(404, "Not Found")

    def handle_callbacks_read(self, query):
        """Read back what the page has reported. Needs the second secret.

        The access key alone is not enough here, on purpose: whoever holds the
        link should be able to send a note without being able to read everyone
        else's.
        """
        want = (self.MANIFEST or {}).get('callback_token')
        got = query.get('cb', [None])[0]
        if not want or not got or not secrets.compare_digest(got, want):
            self.log_request_entry('/callbacks', 403)
            self.send_json(403, {'ok': False, 'error': 'forbidden'})
            return
        root = self.ARTIFACT_ROOT if self.IS_DIRECTORY else self.ARTIFACT_ROOT.parent
        path = root / '_callbacks.jsonl'
        entries = []
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except Exception:
                        pass
        self.log_request_entry('/callbacks', 200)
        self.send_json(200, {'ok': True, 'count': len(entries),
                             'entries': entries[-50:]})

    UPLOAD_MAX = 8 * 1024 * 1024
    # Magic bytes, not the Content-Type header. A browser will happily send
    # whatever it is told to, and this endpoint writes to disk.
    UPLOAD_KINDS = (
        (b'\xff\xd8\xff', 'jpg'),
        (b'\x89PNG\r\n\x1a\n', 'png'),
    )

    def handle_upload(self, query):
        """Accept one photo from the page and drop it in a quarantine directory.

        Deliberately dumb. The server does not decide what a photo MEANS: it
        writes bytes to `img/upload/<sanitised>.<ext>` and records a normal
        callback line. Whoever owns the artifact reads that line and decides
        whether the file becomes a dish's hero shot or is thrown away. Keeping
        the decision out of a public endpoint is the whole point, and it means
        the only path this can ever write to is one directory it builds itself.

        The bytes go here rather than base64 inside a callback because the
        callback log is read and parsed on every poll, and a megabyte of base64
        on one line would make that progressively slower forever.
        """
        root = self.ARTIFACT_ROOT if self.IS_DIRECTORY else self.ARTIFACT_ROOT.parent
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        if length <= 0 or length > self.UPLOAD_MAX:
            self.log_request_entry('/upload', 413)
            self.send_json(413, {'ok': False, 'error': 'bad size'})
            return
        data = self.rfile.read(length)

        ext = next((e for magic, e in self.UPLOAD_KINDS if data.startswith(magic)), None)
        if not ext:
            self.log_request_entry('/upload', 415)
            self.send_json(415, {'ok': False, 'error': 'not an image'})
            return

        # Everything about the name is rebuilt from scratch rather than trusted:
        # no separators survive, so there is nothing to traverse with.
        raw = (query.get('name', [''])[0] or 'photo')
        safe = re.sub(r'[^A-Za-z0-9_-]', '-', raw)[:80].strip('-') or 'photo'
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        rel = f'img/upload/{safe}-{stamp}.{ext}'
        try:
            dest = root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        except Exception:
            self.log_request_entry('/upload', 500)
            self.send_json(500, {'ok': False, 'error': 'could not write'})
            return

        entry = {
            'kind': 'photo',
            'file': rel,
            'bytes': len(data),
            'recipe': (query.get('recipe', [''])[0] or '')[:120],
            'step': (query.get('step', [''])[0] or '')[:8],
            'profile': (query.get('profile', [''])[0] or '')[:120],
            'ts': datetime.now().isoformat(timespec='seconds'),
        }
        try:
            with CALLBACK_LOCK:
                with open(root / '_callbacks.jsonl', 'a') as f:
                    f.write(json.dumps(entry, default=str) + '\n')
        except Exception:
            self.log_request_entry('/upload', 500)
            self.send_json(500, {'ok': False, 'error': 'could not record'})
            return
        self.log_request_entry('/upload', 200)
        self.send_json(200, {'ok': True, 'file': rel})

    def handle_callback(self, body):
        """Let a page report something back to whoever built it.

        Appends one JSON object per call to _callbacks.jsonl. The GET path already
        refuses anything starting with an underscore, so what gets sent back is
        write-only from the browser's side. Whoever built the page is expected to
        watch that file; the server's job ends at recording the fact.
        """
        root = self.ARTIFACT_ROOT if self.IS_DIRECTORY else self.ARTIFACT_ROOT.parent
        try:
            payload = json.loads(body) if body.strip() else {}
            if not isinstance(payload, dict):
                raise ValueError('expected an object')
        except Exception:
            self.log_request_entry('/callback', 400)
            self.send_json(400, {'ok': False, 'error': 'expected a JSON object'})
            return

        entry = {}
        for k in list(payload)[:20]:
            v = payload[k]
            entry[str(k)[:60]] = v[:2000] if isinstance(v, str) else v
        # The server timestamp is authoritative — a browser clock can be wrong or
        # deliberately set — but it is only second-resolution, so two taps in the
        # same second would be indistinguishable. Keep whatever the page sent as
        # `client_ts` so a consumer needing a truly unique key can combine them.
        if 'ts' in entry:
            entry['client_ts'] = entry['ts']
        entry['ts'] = datetime.now().isoformat(timespec='seconds')
        try:
            with CALLBACK_LOCK:
                with open(root / '_callbacks.jsonl', 'a') as f:
                    f.write(json.dumps(entry, default=str) + '\n')
        except Exception:
            self.log_request_entry('/callback', 500)
            self.send_json(500, {'ok': False, 'error': 'could not record'})
            return
        self.log_request_entry('/callback', 200)
        self.send_json(200, {'ok': True})
    
    def do_HEAD(self):
        self.do_GET()


def update_registry_entry(artifact_id, updates):
    """Update an existing registry entry."""
    registry = load_registry()
    if artifact_id in registry['artifacts']:
        registry['artifacts'][artifact_id].update(updates)
        save_registry(registry)


def cleanup_on_exit(artifact_id):
    """Clean up registry on exit."""
    unregister_artifact(artifact_id)


def main():
    if len(sys.argv) < 2:
        print("Usage: secure_server.py <path> [port] [expire_minutes]", file=sys.stderr)
        sys.exit(1)
    
    artifact_path = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    expire_minutes = int(sys.argv[3]) if len(sys.argv) > 3 else None
    
    if not artifact_path.exists():
        print(f"Error: Not found: {artifact_path}", file=sys.stderr)
        sys.exit(1)
    
    is_directory = artifact_path.is_dir()
    # Both are normally fresh secrets. They can be pinned so a running share can
    # be restarted in place — same port, same token, cloudflared left alone — to
    # pick up a server-side fix without invalidating a URL people already have.
    # Pinning is opt-in and explicit: a reused token is a reused secret.
    auth_token = os.environ.get('INSTANT_SHARE_TOKEN') or secrets.token_urlsafe(24)
    artifact_id = os.environ.get('INSTANT_SHARE_ARTIFACT_ID') or secrets.token_urlsafe(8)
    started_at = datetime.utcnow()
    
    SERVER_STATE['started_at'] = started_at.strftime("%H:%M:%S UTC")
    SERVER_STATE['artifact_id'] = artifact_id
    if expire_minutes:
        SERVER_STATE['expire_at'] = started_at + timedelta(minutes=expire_minutes)
        SERVER_STATE['expire_minutes'] = expire_minutes
    
    manifest_path = artifact_path / 'artifact.json' if is_directory else artifact_path.parent / 'artifact.json'
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except:
            pass
    
    # A second secret, never printed into the page, so a link holder can POST
    # feedback but cannot read back what anyone else submitted.
    if not manifest.get('callback_token'):
        manifest['callback_token'] = secrets.token_urlsafe(18)
        try:
            manifest_path.write_text(json.dumps(manifest, indent=2))
        except Exception:
            pass

    # Register in global registry
    register_artifact(artifact_id, {
        'name': manifest.get('name', 'Unnamed'),
        'path': str(artifact_path),
        'started': started_at.strftime("%H:%M:%S"),
        'expire_minutes': expire_minutes,
        'pid': os.getpid(),
        'token': auth_token
    })
    
    # Clean up on exit
    import atexit
    atexit.register(cleanup_on_exit, artifact_id)
    
    SecureArtifactHandler.AUTH_TOKEN = auth_token
    SecureArtifactHandler.ARTIFACT_ROOT = artifact_path
    SecureArtifactHandler.ARTIFACT_ID = artifact_id
    SecureArtifactHandler.IS_DIRECTORY = is_directory
    SecureArtifactHandler.MANIFEST = manifest
    
    if not is_directory:
        with open(artifact_path, 'rb') as f:
            SecureArtifactHandler.FILE_CONTENT = f.read()
    
    # Threaded, because a plain TCPServer serves exactly one request at a time.
    # A page with a photo per product issues ~100 parallel GETs and every one of
    # them queued behind the last, so the catalogue filled in over tens of
    # seconds and looked broken. Daemon threads so a stuck client cannot keep the
    # process alive after shutdown.
    class ThreadedHTTPServer(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True

    with ThreadedHTTPServer(("127.0.0.1", port), SecureArtifactHandler) as httpd:
        actual_port = httpd.server_address[1]
        
        print(f"PORT={actual_port}")
        print(f"TOKEN={auth_token}")
        print(f"ARTIFACT_ID={artifact_id}")
        print(f"ARTIFACT_PATH={artifact_path}")
        print(f"ADMIN_URL=http://127.0.0.1:{actual_port}/admin/?key={auth_token}")
        print(f"EXPIRE_MINUTES={expire_minutes or 'never'}")
        print("SERVER_READY")
        sys.stdout.flush()

        expiry_timer = None
        if expire_minutes:
            def expire_server():
                SERVER_STATE['killed'] = True
                unregister_artifact(artifact_id)
                httpd.shutdown()

            expiry_timer = threading.Timer(expire_minutes * 60, expire_server)
            expiry_timer.daemon = True
            expiry_timer.start()

        def stop_server(_signum, _frame):
            # shutdown() must run from a thread other than serve_forever().
            threading.Thread(target=httpd.shutdown, daemon=True).start()

        previous_term = signal.signal(signal.SIGTERM, stop_server)
        previous_int = signal.signal(signal.SIGINT, stop_server)
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            if expiry_timer:
                expiry_timer.cancel()
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGINT, previous_int)
            unregister_artifact(artifact_id)


if __name__ == "__main__":
    main()
