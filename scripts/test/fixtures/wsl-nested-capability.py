"""Synthetic capability spike only; no production helper edit or owner files."""
import ctypes,errno,json,os,pathlib,select,shutil,signal,socket,stat,struct,subprocess,tempfile,time
import types
import bmn_root_session as helper
libc=helper.LIBC
def probe(uid):
    result={'uid':uid,'profileComplete':False}
    try:
        # The UID drop resets dumpability and makes proc mapping files root-owned.
        # Enable only this synthetic leased UID's own proc-file access; the
        # separate UID/private namespaces and outside-process syscall denials stay.
        result['dumpableBefore']=libc.prctl(3,0,0,0,0)
        result['mappingOwnerBefore']=pathlib.Path('/proc/self/uid_map').stat().st_uid
        helper.checked(libc.prctl(4,1,0,0,0))
        result['mappingOwnerAfter']=pathlib.Path('/proc/self/uid_map').stat().st_uid
        assert result['mappingOwnerAfter']==uid,result
        ctypes.set_errno(0)
        code=libc.unshare(0x10000000|0x00020000|0x40000000|0x08000000|0x04000000)
        if code:
            result.update(stage='unshare',errno=ctypes.get_errno(),status='UNAVAILABLE')
        else:
            result['unshare']=True
            assert not pathlib.Path('/.old-root').exists()
            result['oldRootDetached']=True
            try:pathlib.Path('/proc/self/uid_map').write_text('0 0 4096\n');raise AssertionError('outside UID mapping accepted')
            except PermissionError:result['outsideUidMapDenied']=True
            pathlib.Path('/proc/self/setgroups').write_text('deny\n')
            pathlib.Path('/proc/self/uid_map').write_text(f'0 {uid} 1\n')
            pathlib.Path('/proc/self/gid_map').write_text(f'0 {uid} 1\n')
            helper.checked(libc.setresuid(0,0,0));helper.checked(libc.setresgid(0,0,0))
            result['nestedUid']=os.getuid();result['uidMap']=pathlib.Path('/proc/self/uid_map').read_text().strip()
            nested=pathlib.Path('/workspace/nested');nested.mkdir()
            helper.mount('tmpfs',nested,'tmpfs',2|4,'size=1m,mode=0700')
            (nested/'retained').write_text('synthetic');result['privateMountWrite']=True
            ctypes.set_errno(0);code=libc.mount(None,b'/usr',None,ctypes.c_ulong(4096|32),None)
            assert code==-1,'readonly inherited tools remount became writable'
            result['readOnlyRemountDenied']=ctypes.get_errno()
            for number,args in [(101,[0,-1,0,0]),(308,[-1,0]),(438,[-1,-1,0]),(304,[-1,0,0]),(310,[1,0,0,0,0,0]),(103,[10,0,0])]:
                ctypes.set_errno(0);code=libc.syscall(number,*args);assert code==-1 and ctypes.get_errno()==(errno.EACCES if number==103 else errno.EPERM),(number,code,ctypes.get_errno())
            result['outsideSyscallsDenied']=True
            with socket.socket(socket.AF_UNIX) as s:
                try:s.connect(outside_address);raise AssertionError('outside broker reachable')
                except ConnectionRefusedError:result['outsideBrokerDenied']=True
            assert pathlib.Path('/proc/self/status').read_text().find('NoNewPrivs:\t1')!=-1
            result.update(noNewPrivileges=True,status='PASS_KERNEL_PROBE_ONLY')
    except BaseException as error:result.update(status='FAIL',error=type(error).__name__,message=str(error))
    print(json.dumps(result),flush=True)

def probe_bwrap(uid):
    """Real offline sandbox execution, still not an agent/product adapter."""
    result={'status':'FAIL','profileComplete':False,'outerUid':uid}
    try:
        binary=pathlib.Path('/usr/bin/bwrap')
        mode=binary.stat().st_mode
        assert not mode & (stat.S_ISUID|stat.S_ISGID),'Non-setuid sandbox required'
        helper.checked(libc.prctl(4,1,0,0,0))
        assert pathlib.Path('/proc/self/uid_map').stat().st_uid==uid
        # The root controller created this NETNS before dropping the UID and
        # installing the synthetic filter. No inherited network/namespace FD
        # may reach the payload, including a socket to the outside broker.
        assert os.readlink('/proc/self/ns/net')!=outside_network_namespace
        assert pathlib.Path('/proc/self/ns/net').stat().st_uid==0
        descriptors={}
        for name in os.listdir('/proc/self/fd'):
            try:descriptors[name]=os.readlink('/proc/self/fd/'+name)
            except FileNotFoundError:pass  # The enumeration's own closed FD.
        assert set(descriptors)=={'0','1','2'},descriptors
        assert all(not target.startswith(('socket:','net:','user:')) for target in descriptors.values())
        result.update(privateNetworkNamespace=True,rootOwnedNetworkNamespace=True,inheritedDescriptorsIsolated=True)
        # Open only after isolation. RTM_GETLINK corroborates the empty topology;
        # it is not a claim that subsequent rtnetlink messages are loopback-only.
        with socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,0) as route:
            route.settimeout(1);route.bind((0,0))
            route.send(struct.pack('IHHII',32,18,0x301,1,0)+struct.pack('BBHiII',0,0,0,0,0,0))
            links=[];finished=False
            for _ in range(16):
                data=route.recv(65536);offset=0
                while offset<len(data):
                    length,kind,flags,sequence,pid=struct.unpack_from('IHHII',data,offset)
                    assert length>=16 and offset+length<=len(data) and sequence==1
                    if kind==3:finished=True
                    elif kind==16:
                        position=offset+32
                        while position<offset+length:
                            size,attribute=struct.unpack_from('HH',data,position)
                            assert size>=4 and position+size<=offset+length
                            if attribute==3:links.append(data[position+4:position+size].rstrip(b'\0').decode('ascii'))
                            position+=(size+3)&~3
                    else:raise AssertionError(('Unexpected route reply',kind))
                    offset+=(length+3)&~3
                if finished:break
            assert finished and links==['lo'],links
        for protocol in [9,15,16]:  # AUDIT, KOBJECT_UEVENT, GENERIC.
            try:
                channel=socket.socket(socket.AF_NETLINK,socket.SOCK_RAW,protocol)
            except PermissionError as error:assert error.errno==errno.EPERM
            else:channel.close();raise AssertionError(('Other netlink protocol allowed',protocol))
        for kind in [socket.SOCK_DGRAM,socket.SOCK_STREAM]:
            try:channel=socket.socket(socket.AF_NETLINK,kind,0)
            except PermissionError as error:assert error.errno==errno.EPERM
            else:channel.close();raise AssertionError(('Other netlink socket type allowed',kind))
        result.update(routeSocketCreatedAfterIsolation=True,onlyLoopbackPresent=True,otherNetlinkProtocolsDenied=True,otherNetlinkTypesDenied=True)
        code="""import ctypes,errno,json,os,pathlib,socket
status=pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in status
for name in ['CapEff','CapPrm','CapInh','CapAmb']:assert name+':\\t0000000000000000' in status
assert os.getuid()==0 and os.getgid()==0
uidmap=pathlib.Path('/proc/self/uid_map').read_text().split()
assert uidmap==['0',str(OUTER_UID),'1'],uidmap
assert not pathlib.Path('/.old-root').exists()
pathlib.Path('/workspace/bwrap-proof').write_text('nested synthetic project')
libc=ctypes.CDLL(None,use_errno=True)
for number,args in [(101,[0,-1,0,0]),(308,[-1,0]),(438,[-1,-1,0]),(103,[10,0,0])]:
 ctypes.set_errno(0);value=libc.syscall(number,*args)
 assert value==-1 and ctypes.get_errno()==(errno.EACCES if number==103 else errno.EPERM)
try:pathlib.Path('/proc/self/uid_map').write_text('0 0 4096\\n');raise AssertionError('Outside UID mapping accepted')
except PermissionError:pass
with socket.socket(socket.AF_UNIX) as channel:
 try:channel.connect(OUTSIDE_ADDRESS);raise AssertionError('Outside abstract broker reachable')
 except ConnectionRefusedError:pass
print(json.dumps({'nestedUid':os.getuid(),'singleUidMap':True,'noNewPrivileges':True,'capabilitiesDropped':True,'outsideUidMapDenied':True,'outsideSyscallsDenied':True,'outsideBrokerDenied':True,'privateWorkspaceWrite':True,'oldRootDetached':True,'namespaces':{name:os.readlink('/proc/self/ns/'+name) for name in ['user','mnt','pid','net','ipc','uts']}}))
""".replace('OUTER_UID',str(uid)).replace('OUTSIDE_ADDRESS',repr(outside_address))
        before={name:os.readlink('/proc/self/ns/'+name) for name in ['user','mnt','pid','net','ipc','uts']}
        argv=[str(binary),'--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts',
              '--uid','0','--gid','0','--die-with-parent','--new-session','--cap-drop','ALL',
              '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib',
              '--ro-bind','/lib64','/lib64','--ro-bind','/etc','/etc','--proc','/proc','--dev','/dev',
              '--tmpfs','/tmp','--dir','/home','--bind','/workspace','/workspace','--chdir','/workspace',
              '/usr/bin/python3','-c',code]
        run=subprocess.run(argv,capture_output=True,text=True,timeout=8)
        result.update(exit=run.returncode,stderr=run.stderr[:4000],version=subprocess.check_output([str(binary),'--version'],text=True).strip())
        if run.returncode==0:
            proof=json.loads(run.stdout)
            assert all(proof['namespaces'][name]!=before[name] for name in before)
            assert pathlib.Path('/workspace/bwrap-proof').read_text()=='nested synthetic project'
            result.update(status='PASS_REAL_BWRAP_ONLY',proof=proof)
    except BaseException as error:result.update(error=type(error).__name__,message=str(error))
    print(json.dumps(result),flush=True)


def measure_case(entry=probe):
    global helper,libc,outside_address,outside_network_namespace
    root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-nested-capability-'));os.chmod(root,0o700)
    runtime=root/'runtime';runtime.mkdir(mode=0o700)
    outside_address='\0bmn-nested-'+str(os.getpid())
    outside_network_namespace=os.readlink('/proc/self/ns/net')
    outside=socket.socket(socket.AF_UNIX);outside.bind(outside_address);outside.listen()
    with socket.socket(socket.AF_UNIX) as positive:
        positive.connect(outside_address)
        accepted,_=outside.accept();accepted.close()
    read_in,write_in=os.pipe();read_out,write_out=os.pipe();child=os.fork()
    if child==0:
        os.close(write_in);os.close(read_out);os.dup2(read_in,0);os.dup2(write_out,1)
        directory=root/'session';directory.mkdir()
        helper.run_session(directory,os.open(runtime,os.O_RDONLY|os.O_DIRECTORY),entry)
    os.close(read_in);os.close(write_out)
    controller=os.pidfd_open(child)
    output=b'';deadline=time.monotonic()+15;done=False
    try:
        while time.monotonic()<deadline:
            ready=select.select([read_out],[],[],max(0,deadline-time.monotonic()))[0]
            if not ready:break
            part=os.read(read_out,65536)
            if not part:break
            output+=part
        if not select.select([controller],[],[],max(0,deadline-time.monotonic()))[0]:
            try:signal.pidfd_send_signal(controller,signal.SIGKILL)
            except ProcessLookupError:pass
        _,status=os.waitpid(child,0)
        done=True
        assert os.waitstatus_to_exitcode(status)==0,status
        result=json.loads(output);result['kernel']=os.uname().release;result['scope']='nested userns/mount prototype';result['outsideBrokerPositiveControl']=True;return result
    finally:
        if not done:
            if not select.select([controller],[],[],0)[0]:
                try:signal.pidfd_send_signal(controller,signal.SIGKILL)
                except ProcessLookupError:pass
            os.waitpid(child,0)
        for fd in [write_in,read_out,controller]:os.close(fd)
        outside.close();shutil.rmtree(root)


def candidate_source(original, nested, pivot):
    # Git's native Windows checkout may supply CRLF through the JSON packet.
    source=original.replace('\r\n','\n')
    if nested:
        old='    for number in blocked:\n'
        assert source.count(old)==1
        source=source.replace(old,'    blocked = [n for n in blocked if n not in {105, 106, 113, 114, 117, 119, 122, 123, 165, 166, 155, 272}]\n'+old)
        old='NAMESPACES | 0x10000000 | 0x02000000 | 0x00000080'
        assert source.count(old)==1
        source=source.replace(old,'0x02000000 | 0x00000080 | 0x00008000 | 0x00002000')
        # Descendants may create their own sandbox namespaces, not enter an
        # existing namespace, add cgroup/time authority or change parentage.
        old="    # clone3's pointer flags are opaque to classic BPF. ENOSYS permits ordinary\n"
        assert source.count(old)==1
        policy="""    allowed_unshare = NAMESPACES | 0x10000000 | 0x200 | 0x400 | 0x40000
    ops.extend([(0x15, 0, 4, 272), (0x20, 0, 0, 16),
                (0x45, 0, 1, (~allowed_unshare) & 0xffffffff),
                (0x06, 0, 0, denied), (0x06, 0, 0, allow)])
"""
        source=source.replace(old,policy+old)
        # Owner-approved exception for this disposable experiment only. Kernel
        # socket arguments are int values: compare their low 32 bits. Permit
        # only socket(AF_NETLINK, SOCK_RAW [+ CLOEXEC/NONBLOCK], protocol=0),
        # never socketpair or another family/type/protocol. Architecture guards
        # above still reject compat socketcall and x32 before these offsets.
        old='                (0x15, 1, 0, 41), (0x15, 0, 5, 53), (0x20, 0, 0, 16),\n'
        assert source.count(old)==1
        route="""                (0x15, 0, 12, 41), (0x20, 0, 0, 16),
                (0x15, 0, 10, 16), (0x20, 0, 0, 24),
                (0x15, 4, 0, 3), (0x15, 3, 0, 3 | 0x80000),
                (0x15, 2, 0, 3 | 0x800), (0x15, 1, 0, 3 | 0x80800),
                (0x06, 0, 0, denied), (0x20, 0, 0, 32),
                (0x15, 1, 0, 0), (0x06, 0, 0, denied),
                (0x06, 0, 0, allow), (0x20, 0, 0, 0),
"""
        source=source.replace(old,route+old)
    if pivot:
        old='    os.chroot(directory)\n'
        assert source.count(old)==1
        source=source.replace(old,"    os.chdir(directory)\n    os.mkdir('.old-root')\n    checked(LIBC.syscall(155, b'.', b'.old-root'))\n    os.chdir('/')\n    checked(LIBC.umount2(b'/.old-root', 2))\n    os.rmdir('/.old-root')\n")
    return source

rows=[]
for nested,pivot in [(False,False),(True,False),(False,True),(True,True)]:
    helper=types.ModuleType('bmn_nested_kernel_candidate')
    exec(compile(candidate_source(ROOT_HELPER_SOURCE,nested,pivot),'synthetic-kernel-candidate.py','exec'),helper.__dict__)
    libc=helper.LIBC
    row=measure_case();row.update(amendedFilter=nested,pivotRoot=pivot)
    if nested and pivot:
        assert row['status']=='PASS_KERNEL_PROBE_ONLY',row
        for key in ['outsideUidMapDenied','privateMountWrite','outsideSyscallsDenied','outsideBrokerDenied','noNewPrivileges','outsideBrokerPositiveControl','oldRootDetached']:
            assert row[key] is True,(key,row)
    else:
        assert row['status']=='UNAVAILABLE' and row['errno']==errno.EPERM,row
    rows.append(row)
sandbox=measure_case(probe_bwrap)
print(json.dumps({'scope':'synthetic chroot/pivot versus seccomp kernel discriminator plus real nested bwrap','profileComplete':False,'rows':rows,'sandbox':sandbox}))
