"""Talk to the running VS Code over its main process socket.

The code CLI is a shell script that starts a whole Electron process, which
then connects to the socket of the running VS Code, hands over the arguments
and quits, about a second of work. This module connects to that socket
directly, the same call the CLI makes, in a few milliseconds. On Linux the
socket sits in $XDG_RUNTIME_DIR as vscode-<hash>-<version>-main.sock, the hash
is the start of the sha256 of the user data dir, the version the start of the
VS Code version. Without $XDG_RUNTIME_DIR, the normal case on macOS, it sits in
the user data dir as <version>-main.sock. The user data dir is
~/.config/Code on Linux and ~/Library/Application Support/Code on macOS.

Wire format, read from the ipc.net and ipc modules of VS Code 1.136
    frame      type (1 byte, 1 is a regular message), id (4 bytes), ack (4 bytes),
               payload length (4 bytes), all big endian, then the payload
    payload    a type tag then the value, 0 undefined, 1 string, 4 array,
               5 object as JSON, 6 int, lengths and ints as 7 bit varints
    handshake  the client sends its context string, the server answers [200]
    request    [100, request id, channel, method] then the argument, here
               ["launch", "start"] with [args, env] as the code CLI sends them
    reply      [201, request id] then the result, [202, id] and [203, id]
               carry an error

The format is internal to VS Code. Anything unexpected raises Unavailable and
the caller falls back to the CLI, which keeps working across versions.
"""

import glob
import hashlib
import json
import os
import socket
import struct
import sys

USER_DATA_DIRS = ["Code", "Code - Insiders", "VSCodium", "Code - OSS"]
REGULAR = 1
REQUEST_PROMISE = 100
RESPONSE_INITIALIZE = 200
RESPONSE_SUCCESS = 201
RESPONSE_ERRORS = (202, 203)
HEADER = struct.Struct(">BIII")
TIMEOUT_S = 3.0


class Unavailable(Exception):
    """No running VS Code answered on the socket in the expected way."""


def varint(value):
    if value == 0:
        return b"\x00"
    out = bytearray()
    while value:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80
        out.append(byte)
    return bytes(out)


def serialize(data):
    if data is None:
        return b"\x00"
    if isinstance(data, str):
        raw = data.encode("utf-8")
        return b"\x01" + varint(len(raw)) + raw
    if isinstance(data, list):
        return b"\x04" + varint(len(data)) + b"".join(serialize(item) for item in data)
    if isinstance(data, int) and not isinstance(data, bool):
        return b"\x06" + varint(data)
    raw = json.dumps(data).encode("utf-8")
    return b"\x05" + varint(len(raw)) + raw


def _read_varint(buf, pos):
    value = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, pos


def deserialize(buf, pos=0):
    """Returns the value at pos and the position after it."""
    tag = buf[pos]
    pos += 1
    if tag == 0:
        return None, pos
    if tag == 1:
        length, pos = _read_varint(buf, pos)
        return buf[pos : pos + length].decode("utf-8"), pos + length
    if tag in (2, 3):
        length, pos = _read_varint(buf, pos)
        return bytes(buf[pos : pos + length]), pos + length
    if tag == 4:
        count, pos = _read_varint(buf, pos)
        items = []
        for _ in range(count):
            item, pos = deserialize(buf, pos)
            items.append(item)
        return items, pos
    if tag == 5:
        length, pos = _read_varint(buf, pos)
        return json.loads(buf[pos : pos + length]), pos + length
    if tag == 6:
        return _read_varint(buf, pos)
    raise ValueError(f"unknown type tag {tag}")


def main_sockets():
    """Candidate main sockets of running or crashed VS Code instances, the stable build first."""
    if sys.platform == "darwin":
        config_home = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    found = []
    for name in USER_DATA_DIRS:
        user_data = os.path.join(config_home, name)
        scope = hashlib.sha256(user_data.encode("utf-8")).hexdigest()[:8]
        found += sorted(glob.glob(os.path.join(runtime_dir, f"vscode-{scope}-*-main.sock")))
        # without XDG_RUNTIME_DIR VS Code keeps the socket in the user data dir
        found += sorted(glob.glob(os.path.join(user_data, "*-main.sock")))
    return found


def _frame(payload):
    return HEADER.pack(REGULAR, 0, 0, len(payload)) + payload


def _read_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise Unavailable("VS Code closed the socket")
        data += chunk
    return data


def _read_frame(sock):
    kind, _id, _ack, length = HEADER.unpack(_read_exact(sock, HEADER.size))
    payload = _read_exact(sock, length)
    return payload if kind == REGULAR else None


def launch(sock_path, args, env, timeout_s=TIMEOUT_S):
    """Run launch.start(args, env) on the socket, the call the code CLI makes."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout_s)
    try:
        sock.connect(sock_path)
        sock.sendall(_frame(serialize("main")))
        sock.sendall(_frame(serialize([REQUEST_PROMISE, 0, "launch", "start"]) + serialize([args, env])))
        while True:
            payload = _read_frame(sock)
            if payload is None:
                continue
            header, pos = deserialize(payload)
            if not isinstance(header, list) or not header:
                raise Unavailable(f"unexpected reply {header!r}")
            if header[0] == RESPONSE_INITIALIZE:
                continue
            if len(header) < 2 or header[1] != 0:
                continue
            if header[0] == RESPONSE_SUCCESS:
                return
            if header[0] in RESPONSE_ERRORS:
                detail = deserialize(payload, pos)[0] if pos < len(payload) else None
                message = detail.get("message") if isinstance(detail, dict) else detail
                raise Unavailable(f"VS Code refused the request, {message}")
            raise Unavailable(f"unexpected reply {header!r}")
    except (OSError, ValueError, IndexError, struct.error) as error:
        raise Unavailable(f"{sock_path}, {error}") from error
    finally:
        sock.close()


def open_paths(paths, env, sockets=None):
    """Open folders and file:line:column paths in the running VS Code, as code --goto does.

    Returns the socket that took the request, raises Unavailable when none did.
    """
    args = {"_": list(paths), "goto": True}
    user_env = {**env, "VSCODE_CLI": "1"}
    errors = []
    for sock_path in main_sockets() if sockets is None else sockets:
        try:
            launch(sock_path, args, user_env)
            return sock_path
        except Unavailable as error:
            errors.append(str(error))
    raise Unavailable("; ".join(errors) or "no VS Code main socket found")
