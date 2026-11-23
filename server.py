#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""佳兴族谱 · 本地后端服务

提供：
  - 静态文件服务（前端页面）
  - 登录 / 退出（PBKDF2 密码哈希，令牌有效期 7 天）
  - 族谱数据读写（SQLite 持久化）

启动：python server.py
默认账号：admin  默认密码：Admin123456
"""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

FROZEN = getattr(sys, 'frozen', False)
if FROZEN:
    # 打包后：静态资源在临时解包目录，数据保存在 exe 同级的 data 目录
    ROOT = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    DATA_DIR = os.path.join(os.path.dirname(sys.executable), 'data')
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = os.path.join(ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'family.db')
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8765'))

DEFAULT_USER = 'admin'
DEFAULT_PASSWORD = 'Admin123456'
PBKDF2_ITERATIONS = 200_000
SESSION_TTL = 7 * 24 * 3600
MAX_BODY = 25 * 1024 * 1024

LOCK = threading.Lock()


def say(message):
    """pythonw 后台运行时没有标准输出，打印需要容错。"""
    try:
        if sys.stdout is not None:
            print(message)
    except Exception:
        pass


def password_strong(pw):
    """密码规则：超过 8 位，且同时包含大写字母、小写字母和数字。"""
    return (
        len(pw) > 8
        and any(c.isupper() for c in pw)
        and any(c.islower() for c in pw)
        and any(c.isdigit() for c in pw)
    )


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    if not password_strong(DEFAULT_PASSWORD):
        raise RuntimeError('默认密码不符合规则：需超过 8 位且包含大小写字母与数字')
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = connect()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                username   TEXT PRIMARY KEY,
                salt       TEXT NOT NULL,
                password   TEXT NOT NULL,
                iterations INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                username   TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS family_data (
                id         INTEGER PRIMARY KEY CHECK (id = 1),
                payload    TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        """)
        if conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n'] == 0:
            salt = secrets.token_bytes(16)
            digest = hashlib.pbkdf2_hmac(
                'sha256', DEFAULT_PASSWORD.encode('utf-8'), salt, PBKDF2_ITERATIONS
            )
            conn.execute(
                'INSERT INTO users (username, salt, password, iterations, created_at) '
                'VALUES (?, ?, ?, ?, ?)',
                (DEFAULT_USER, salt.hex(), digest.hex(), PBKDF2_ITERATIONS, int(time.time()))
            )
            say('已创建默认账号：%s / %s' % (DEFAULT_USER, DEFAULT_PASSWORD))
        conn.commit()
    finally:
        conn.close()


def verify_user(username, password):
    conn = connect()
    try:
        row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    finally:
        conn.close()
    if not row:
        return False
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), bytes.fromhex(row['salt']), row['iterations']
    )
    return hmac.compare_digest(digest.hex(), row['password'])


def create_session(username):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    conn = connect()
    try:
        conn.execute('DELETE FROM sessions WHERE expires_at < ?', (now,))
        conn.execute(
            'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)',
            (token, username, now + SESSION_TTL)
        )
        conn.commit()
    finally:
        conn.close()
    return token


def session_user(token):
    if not token:
        return None
    conn = connect()
    try:
        row = conn.execute(
            'SELECT username, expires_at FROM sessions WHERE token = ?', (token,)
        ).fetchone()
        if not row:
            return None
        if row['expires_at'] < int(time.time()):
            conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
            conn.commit()
            return None
        return row['username']
    finally:
        conn.close()


def drop_session(token):
    conn = connect()
    try:
        conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
        conn.commit()
    finally:
        conn.close()


def read_family():
    conn = connect()
    try:
        row = conn.execute('SELECT payload, updated_at FROM family_data WHERE id = 1').fetchone()
    finally:
        conn.close()
    if not row:
        return None, 0
    try:
        return json.loads(row['payload']), row['updated_at']
    except ValueError:
        return None, 0


def write_family(payload):
    text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    now = int(time.time())
    conn = connect()
    try:
        conn.execute(
            'INSERT INTO family_data (id, payload, updated_at) VALUES (1, ?, ?) '
            'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
            (text, now)
        )
        conn.commit()
    finally:
        conn.close()
    return now


class Handler(SimpleHTTPRequestHandler):
    server_version = 'ZupuServer/1.0'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 基础工具 ----------
    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return None
        if length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def auth_user(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return None
        return session_user(header[7:].strip())

    def blocked(self, path):
        p = path.split('?')[0].lstrip('/')
        return (
            p.startswith('data/')
            or p.startswith('.trae/')
            or p.startswith('.git')
            or p == 'server.py'
            or p.startswith('__pycache__')
        )

    def end_headers(self):
        if '.html' in self.path or '.js' in self.path or '.css' in self.path:
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/api/' in self.path:
            try:
                if sys.stderr is not None:
                    super().log_message(fmt, *args)
            except Exception:
                pass

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/'):
            if path == '/api/data':
                user = self.auth_user()
                if not user:
                    return self.send_json(401, {'error': '登录已过期，请重新登录'})
                data, updated_at = read_family()
                return self.send_json(200, {'data': data, 'updatedAt': updated_at, 'username': user})
            return self.send_json(404, {'error': '接口不存在'})
        if self.blocked(path):
            return self.send_json(403, {'error': '禁止访问'})
        return super().do_GET()

    def do_HEAD(self):
        if self.blocked(self.path):
            self.send_error(403)
            return
        return super().do_HEAD()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/login':
            body = self.read_json() or {}
            username = str(body.get('username') or '').strip()
            password = str(body.get('password') or '')
            if not username or not password:
                return self.send_json(400, {'error': '请输入账号和密码'})
            if not verify_user(username, password):
                time.sleep(0.35)
                return self.send_json(401, {'error': '账号或密码不正确'})
            token = create_session(username)
            return self.send_json(200, {'token': token, 'username': username})

        if path == '/api/logout':
            header = self.headers.get('Authorization', '')
            if header.startswith('Bearer '):
                drop_session(header[7:].strip())
            return self.send_json(200, {'ok': True})

        return self.send_json(404, {'error': '接口不存在'})

    def do_PUT(self):
        path = self.path.split('?')[0]
        if path != '/api/data':
            return self.send_json(404, {'error': '接口不存在'})
        if not self.auth_user():
            return self.send_json(401, {'error': '登录已过期，请重新登录'})
        body = self.read_json()
        if not isinstance(body, dict) or not isinstance(body.get('data'), dict):
            return self.send_json(400, {'error': '数据格式不正确'})
        with LOCK:
            updated_at = write_family(body['data'])
        return self.send_json(200, {'ok': True, 'updatedAt': updated_at})


def open_browser():
    if os.environ.get('ZUPU_NO_BROWSER') == '1':
        return
    try:
        webbrowser.open('http://%s:%d' % (HOST, PORT))
    except Exception:
        pass


def main():
    init_db()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        say('服务已在运行，可直接访问： http://%s:%d' % (HOST, PORT))
        open_browser()
        return
    say('族谱服务已启动： http://%s:%d' % (HOST, PORT))
    say('默认账号：%s  密码：%s' % (DEFAULT_USER, DEFAULT_PASSWORD))
    say('数据库：%s' % DB_PATH)
    if FROZEN:
        threading.Timer(1.0, open_browser).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        say('\n服务已停止')
    finally:
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(os.path.join(DATA_DIR, 'server.log'), 'a', encoding='utf-8') as fh:
                fh.write('[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), exc))
        except Exception:
            pass
        raise
