"""Synthetic capability spike only; no production helper edit or owner files."""
import ctypes,errno,json,os,pathlib,select,shutil,signal,socket,tempfile,time
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

def measure_case():
    global helper,libc,outside_address
    root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-nested-capability-'));os.chmod(root,0o700)
    runtime=root/'runtime';runtime.mkdir(mode=0o700)
    outside_address='\0bmn-nested-'+str(os.getpid())
    outside=socket.socket(socket.AF_UNIX);outside.bind(outside_address);outside.listen()
    with socket.socket(socket.AF_UNIX) as positive:
        positive.connect(outside_address)
        accepted,_=outside.accept();accepted.close()
    read_in,write_in=os.pipe();read_out,write_out=os.pipe();child=os.fork()
    if child==0:
        os.close(write_in);os.close(read_out);os.dup2(read_in,0);os.dup2(write_out,1)
        directory=root/'session';directory.mkdir()
        helper.run_session(directory,os.open(runtime,os.O_RDONLY|os.O_DIRECTORY),probe)
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
        source=source.replace(old,'0x00000080')
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
print(json.dumps({'scope':'synthetic chroot/pivot versus seccomp kernel discriminator','profileComplete':False,'rows':rows}))
