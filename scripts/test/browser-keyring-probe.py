# MODULE: browser-keyring-probe.py - Test-only lock/unlock of one identity-checked private Secret Service; secrets use stdin.
import json
import os
import sys
from gi.repository import Gio, GLib

try:
    request = json.load(sys.stdin)
    runtime = os.environ['XDG_RUNTIME_DIR']
    address = os.environ['DBUS_SESSION_BUS_ADDRESS']
    assert ';' not in address and address.startswith('unix:path=' + runtime + '/')
    connection = Gio.DBusConnection.new_for_address_sync(
        address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)

    def call(destination, path, interface, method, args=None):
        return connection.call_sync(destination, path, interface, method, args, None,
                                    Gio.DBusCallFlags.NO_AUTO_START, 5000, None).unpack()

    bus = ('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus')
    owner = call(*bus, 'GetNameOwner', GLib.Variant('(s)', ('org.freedesktop.secrets',)))[0]
    pid = call(*bus, 'GetConnectionUnixProcessID', GLib.Variant('(s)', (owner,)))[0]
    assert pid == request['pid'] and (not request.get('owner') or request['owner'] == owner)
    root = '/org/freedesktop/secrets'
    service = 'org.freedesktop.Secret.Service'
    internal = 'org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface'

    def secret_call(path, interface, method, args=None):
        return call(owner, path, interface, method, args)

    collection = secret_call(root, service, 'ReadAlias', GLib.Variant('(s)', ('default',)))[0]
    login = secret_call(root, service, 'ReadAlias', GLib.Variant('(s)', ('login',)))[0]
    assert collection == login == '/org/freedesktop/secrets/collection/login'
    xml = secret_call(root, 'org.freedesktop.DBus.Introspectable', 'Introspect')[0]
    assert internal in xml and 'UnlockWithMasterPassword' in xml
    if request['action'] == 'lock':
        secret_call(root, service, 'Lock', GLib.Variant('(ao)', ([collection],)))
    elif request['action'] == 'unlock':
        session = secret_call(root, service, 'OpenSession', GLib.Variant('(sv)', ('plain', GLib.Variant('s', ''))))[1]
        try:
            master = (session, [], list(request['password'].encode()), 'text/plain')
            secret_call(root, internal, 'UnlockWithMasterPassword', GLib.Variant('(o(oayays))', (collection, master)))
        finally:
            secret_call(session, 'org.freedesktop.Secret.Session', 'Close')
    locked = secret_call(collection, 'org.freedesktop.DBus.Properties', 'Get',
                         GLib.Variant('(ss)', ('org.freedesktop.Secret.Collection', 'Locked')))[0]
    assert locked == (request['action'] == 'lock')
    attrs = {'application': 'bmn-browser', 'account': request.get('account', ''), 'kind': 'profile-key'}
    items = secret_call(root, service, 'SearchItems', GLib.Variant('(a{ss})', (attrs,)))
    print(json.dumps({'ok': True, 'owner': owner, 'pid': pid, 'locked': locked,
                      'items': sorted(items[0] + items[1])}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': type(error).__name__}))
    sys.exit(1)
