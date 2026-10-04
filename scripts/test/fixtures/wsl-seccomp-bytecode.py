"""Interpret the actual compiled synthetic BPF, without namespaces or syscalls.

AST extraction imports no guest-only fcntl/pwd or Linux libc on the Windows host.
Socket constants match the x86_64 guest ABI, not the test host's AF_UNIX value.
"""
import ast,ctypes,errno,json,sys,types

packet=json.load(sys.stdin)
tree=ast.parse(packet['fixture'])
factory_node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='candidate_source')
factory={}
exec(compile(ast.Module(body=[factory_node],type_ignores=[]),'candidate-source','exec'),factory)
source=factory['candidate_source'](packet['helper'],True,True)
tree=ast.parse(source)
nodes=[node for node in tree.body if
       isinstance(node,ast.FunctionDef) and node.name=='restrict_syscalls' or
       isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='NAMESPACES' for target in node.targets)]
scope={'ctypes':ctypes,'errno':errno,'socket':types.SimpleNamespace(AF_UNIX=1,AF_INET=2,AF_INET6=10),'checked':lambda value:None}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'candidate-bytecode','exec'),scope)

class Capture:
    def prctl(self,*args):
        if args[0]==22:
            program=args[2]._obj
            self.ops=[(program.filter[i].code,program.filter[i].jt,program.filter[i].jf,program.filter[i].k) for i in range(program.length)]
        return 0

capture=Capture();scope['LIBC']=capture;scope['restrict_syscalls']()
def decide(number,arg0=0,arg1=0,arg2=0,arch=0xc000003e):
    offset=0;value=0
    for _ in range(len(capture.ops)+1):
        op,yes,no,k=capture.ops[offset];offset+=1
        if op==0x20:value={0:number,4:arch,16:arg0&0xffffffff,24:arg1&0xffffffff,32:arg2&0xffffffff}[k]
        elif op==0x15:offset+=yes if value==k else no
        elif op==0x35:offset+=yes if value>=k else no
        elif op==0x45:offset+=yes if value&k else no
        elif op==0x06:return k
        else:raise AssertionError(op)
    raise AssertionError('Unterminated bytecode')

denied=0x50000|errno.EPERM;allow=0x7fff0000;kill=0x80000000
for number,flags in [(56,0x8000),(56,0x2000),(56,0x2000000),(272,0x2000000),(272,0x80)]:
    assert decide(number,flags)==denied,(number,flags,decide(number,flags))
for number,flags in [(56,17),(56,0x10000000|0x20000|17),(272,0x10000000|0x20000)]:
    assert decide(number,flags)==allow,(number,flags,decide(number,flags))
assert decide(308)==denied
assert decide(435)==0x50000|errno.ENOSYS
for flags in [0,0x80000,0x800,0x80800]:
    assert decide(41,16,3|flags,0)==allow,(flags,'route raw socket refused')
    # Linux truncates these three syscall parameters to int; high bits confer
    # no extra family/type/protocol authority, and the filter follows that ABI.
    assert decide(41,(1<<32)|16,(1<<32)|3|flags,1<<32)==allow
    for protocol in [1,9,15,16,0xffffffff]:assert decide(41,16,3|flags,protocol)==denied
for kind in [0,1,2,4,5,10,3|0x400,3|0x100000]:assert decide(41,16,kind,0)==denied
assert decide(53,16,3,0)==denied
for family in [1,2,10]:
    for number in [41,53]:assert decide(number,family,1,0)==allow
for family in [17,40,0xffffffff]:assert decide(41,family,3,0)==denied
assert decide(102,16,3,0,arch=0x40000003)==kill  # i386 socketcall.
assert decide(0x40000000|41,16,3,0)==kill  # x32 socket.
print('NESTED_FILTER_AND_NARROW_ROUTE_OK')
