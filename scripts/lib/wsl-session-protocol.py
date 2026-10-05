# MODULE: wsl-session-protocol.py - guest side of the WSL session wire protocol (frames, launch schema, guest session)
"""Preparatory (Story 53.5): not wired to BMN and never run as root by itself.

The native side is wsl-session-protocol.mjs; both follow docs/wsl-session-protocol.md and the shared vectors
in scripts/test/fixtures/wsl-session-protocol-vectors.json. Standard library only.
"""
import json
import re
import struct
from typing import NoReturn

PROTOCOL_VERSION = 1
PROFILE_VERSIONS = ('restricted-1',)
CONTROL, TERMINAL, RESIZE = 0, 1, 2
# Reserved until designed and reviewed: bridge (3) and file transfer (4).
RESERVED_CHANNELS = (3, 4)
HEADER_BYTES = 8
MAX_PAYLOAD = 65536
ENVIRONMENT_ALLOWLIST = ('TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
                         'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR')
# Typed failures the guest can report, with the helper's process exit code for each.
HELPER_EXIT_CODES = {'UNSUPPORTED_PROFILE': 69, 'INTERNAL': 70, 'EXEC_FAILED': 71, 'STORAGE_RECOVERY': 74,
                     'LEASE_UNAVAILABLE': 75, 'PROTOCOL': 76, 'AUTH': 77, 'ROOT_DENIED': 78, 'CLEANUP_UNCONFIRMED': 79}


class ProtocolError(Exception):
    def __init__(self, code, reason):
        super().__init__(f'{code}: {reason}')
        self.code = code
        self.reason = reason


def fail(reason, code='PROTOCOL') -> NoReturn:
    raise ProtocolError(code, reason)


def encode_frame(channel, payload):
    if channel not in (CONTROL, TERMINAL, RESIZE):
        fail(f'channel {channel} cannot be sent')
    if (len(payload) != 4) if channel == RESIZE else (len(payload) > MAX_PAYLOAD):
        fail(f'payload of {len(payload)} bytes does not fit channel {channel}')
    return struct.pack('>BBHI', PROTOCOL_VERSION, channel, 0, len(payload)) + bytes(payload)


def encode_control(message):
    return encode_frame(CONTROL, json.dumps(message, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


def encode_terminal(data):
    """Terminal bytes as as many frames as their size needs."""
    frames = [encode_frame(TERMINAL, data[offset:offset + MAX_PAYLOAD]) for offset in range(0, len(data), MAX_PAYLOAD)]
    return frames or [encode_frame(TERMINAL, b'')]


def header_problem(version, channel, reserved, length):
    if version != PROTOCOL_VERSION:
        return f'unsupported frame version {version}'
    if channel in RESERVED_CHANNELS:
        return f'channel {channel} is reserved'
    if channel not in (CONTROL, TERMINAL, RESIZE):
        return f'unknown channel {channel}'
    if reserved != 0:
        return 'reserved header bits are set'
    if (length != 4) if channel == RESIZE else (length > MAX_PAYLOAD):
        return f'a {length}-byte payload does not fit channel {channel}'
    return None


class FrameDecoder:
    """Streaming decoder: push() returns (frames, error); frames before a break in the format are still returned,
    so any split of the same bytes gives the same result. The header is checked before any payload is buffered."""

    def __init__(self):
        self._buffer = b''
        self._failed = False

    @property
    def buffered_bytes(self):
        return len(self._buffer)

    def push(self, chunk):
        if self._failed:
            return [], ProtocolError('PROTOCOL', 'the stream already failed')
        joined = self._buffer + bytes(chunk)
        frames, offset = [], 0
        while len(joined) - offset >= HEADER_BYTES:
            version, channel, reserved, length = struct.unpack_from('>BBHI', joined, offset)
            problem = header_problem(version, channel, reserved, length)
            if problem:
                self._failed, self._buffer = True, b''
                return frames, ProtocolError('PROTOCOL', problem)
            if len(joined) - offset - HEADER_BYTES < length:
                break
            frames.append((channel, joined[offset + HEADER_BYTES:offset + HEADER_BYTES + length]))
            offset += HEADER_BYTES + length
        self._buffer = joined[offset:]
        return frames, None

    def end(self):
        if self._failed or not self._buffer:
            return None
        self._failed = True
        return ProtocolError('PROTOCOL', f'input ended inside a frame ({len(self._buffer)} bytes held)')


def _no_constants(name):
    raise ValueError(name)


def decode_control(payload):
    try:
        text = bytes(payload).decode('utf-8')
    except UnicodeDecodeError:
        fail('control payload is not UTF-8')
    try:
        message = json.loads(text, parse_constant=_no_constants)
    except ValueError:
        fail('control payload is not JSON')
    if not isinstance(message, dict):
        fail('control payload is not an object')
    return message


def _exact_keys(value, keys, field):
    if not isinstance(value, dict):
        fail(f'{field or "message"} must be an object')
    prefix = f'{field}.' if field else ''
    for key in value:
        if key not in keys:
            fail(f'{prefix}{key} is not allowed')
    for key in keys:
        if key not in value:
            fail(f'{prefix}{key} is missing')


def _plain_text(value, field, limit=4096, empty=False):
    if not isinstance(value, str):
        fail(f'{field} must be a string')
    if not empty and len(value) == 0:
        fail(f'{field} is empty')
    if '\0' in value:
        fail(f'{field} contains NUL')
    try:
        encoded = value.encode('utf-8')
    except UnicodeEncodeError:
        fail(f'{field} is not valid Unicode')
    if len(encoded) > limit:
        fail(f'{field} is longer than {limit} bytes')
    return value


def validate_linux_path(value, field):
    _plain_text(value, field)
    if not value.startswith('/'):
        fail(f'{field} is not absolute')
    if value != '/' and any(segment in ('', '.', '..') for segment in value[1:].split('/')):
        fail(f'{field} is not a normalized path')
    return value


def _integer_in(value, low, high, field):
    integral = isinstance(value, int) and not isinstance(value, bool) or isinstance(value, float) and value.is_integer()
    if not integral or not low <= value <= high:
        fail(f'{field} must be an integer from {low} to {high}')
    return int(value)


def _validate_size(size, field):
    _exact_keys(size, ('cols', 'rows'), field)
    _integer_in(size['cols'], 2, 1000, f'{field}.cols')
    _integer_in(size['rows'], 1, 1000, f'{field}.rows')


NONCE = re.compile(r'[0-9a-f]{32}')
REGISTRATION = re.compile(r'\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}')
DISTRIBUTION_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
PROJECT_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def validate_launch(message):
    """Validates a launch message exactly; returns it, or raises PROTOCOL naming the field."""
    _exact_keys(message, ('type', 'protocol', 'profileVersion', 'sessionNonce', 'distribution', 'project', 'shell',
                          'cwd', 'environment', 'size'), '')
    if message['type'] != 'launch':
        fail('type must be launch')
    if isinstance(message['protocol'], bool) or message['protocol'] != PROTOCOL_VERSION:
        fail(f'protocol must be {PROTOCOL_VERSION}')
    if message['profileVersion'] not in PROFILE_VERSIONS:
        fail('profileVersion is not supported')
    if not _matches(NONCE, message['sessionNonce']):
        fail('sessionNonce must be 32 lowercase hex characters')
    _exact_keys(message['distribution'], ('id', 'name'), 'distribution')
    if not _matches(REGISTRATION, message['distribution']['id']):
        fail('distribution.id must be a lowercase registration GUID in braces')
    if not _matches(DISTRIBUTION_NAME, message['distribution']['name']):
        fail('distribution.name is not allowed')
    _exact_keys(message['project'], ('id',), 'project')
    if not _matches(PROJECT_ID, message['project']['id']):
        fail('project.id is not allowed')
    _exact_keys(message['shell'], ('argv',), 'shell')
    argv = message['shell']['argv']
    if not isinstance(argv, list) or not 1 <= len(argv) <= 64:
        fail('shell.argv must hold 1 to 64 strings')
    validate_linux_path(argv[0], 'shell.argv[0]')
    for index, argument in enumerate(argv[1:], start=1):
        _plain_text(argument, f'shell.argv[{index}]', empty=True)
    validate_linux_path(message['cwd'], 'cwd')
    if not isinstance(message['environment'], dict):
        fail('environment must be an object')
    for name, value in message['environment'].items():
        if name not in ENVIRONMENT_ALLOWLIST:
            fail(f'environment.{name} is not allowed')
        _plain_text(value, f'environment.{name}', empty=True)
    _validate_size(message['size'], 'size')
    return message


def helper_exit_code(code):
    """The helper's process exit code for a typed failure; anything unknown is INTERNAL (70)."""
    return HELPER_EXIT_CODES.get(code, HELPER_EXIT_CODES['INTERNAL'])


class GuestSession:
    """The guest side of one session: feeds the native bytes in and returns events (launch, input, resize, stop,
    abort, teardown, failed). End of input before a launch aborts; after it, end of input tears down like Stop."""

    def __init__(self):
        self._decoder = FrameDecoder()
        self.state = 'awaiting-launch'
        self.dropped = 0
        self.failure = None

    def push(self, chunk):
        if self.state in ('failed', 'ended'):
            return []
        events = []
        frames, error = self._decoder.push(chunk)
        try:
            for frame in frames:
                events.extend(self._frame(*frame))
        except ProtocolError as failure:
            events.append(self._failed(failure))
            return events
        if error:
            events.append(self._failed(error))
        return events

    def end(self):
        if self.state in ('failed', 'ended'):
            return []
        truncated = self._decoder.end()
        if truncated:
            return [self._failed(truncated)]
        event = {'type': 'abort'} if self.state == 'awaiting-launch' else {'type': 'teardown', 'reason': 'eof'}
        self.state = 'ended'
        return [event]

    def _failed(self, error):
        self.state = 'failed'
        self.failure = {'code': error.code, 'reason': error.reason}
        return {'type': 'failed', **self.failure}

    def _frame(self, channel, payload):
        if self.state == 'stopping' and channel in (TERMINAL, RESIZE):
            self.dropped += 1
            return []
        if channel == TERMINAL:
            if self.state != 'running':
                fail('terminal input before launch')
            return [{'type': 'input', 'bytes': payload}]
        if channel == RESIZE:
            if self.state != 'running':
                fail('resize before launch')
            cols, rows = struct.unpack('>HH', payload)
            _validate_size({'cols': cols, 'rows': rows}, 'size')
            return [{'type': 'resize', 'cols': cols, 'rows': rows}]
        message = decode_control(payload)
        if self.state == 'awaiting-launch':
            if message.get('type') != 'launch':
                fail('the first message must be launch')
            launch = validate_launch(message)
            self.state = 'running'
            return [{'type': 'launch', 'launch': launch}]
        if self.state == 'stopping':
            fail('control after stop')
        if message.get('type') == 'launch':
            fail('a second launch')
        if message.get('type') == 'stop':
            _exact_keys(message, ('type',), '')
            self.state = 'stopping'
            return [{'type': 'stop'}]
        fail('unknown control message')
