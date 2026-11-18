# MODULE: brain-cutover-files.py - Fail-closed Linux atomic restore with pinned no-follow parents
import ctypes,json,os,sys

def parent(path):
 if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path:raise ValueError('Absolute normalized restore path required')
 parts=path.split('/')[1:]
 if not parts or not parts[-1]:raise ValueError('Restore entry required')
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for name in parts[:-1]:
   nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
  return fd,parts[-1]
 except BaseException:os.close(fd);raise

def identity(fd,name):
 try:
  s=os.stat(name,dir_fd=fd,follow_symlinks=False)
  return {'dev':s.st_dev,'ino':s.st_ino}
 except FileNotFoundError:return None

def main():
 request=json.load(sys.stdin)
 if request.get('operation') not in ('exchange','no-replace'):raise ValueError('Unknown restore operation')
 left,name=parent(request['source'])
 try:
  right,target=parent(request['target'])
  try:
   if identity(left,name)!=request['sourceIdentity'] or identity(right,target)!=request['targetIdentity']:raise ValueError('Restore entry identity changed')
   library=ctypes.CDLL(None,use_errno=True)
   rename=library.renameat2;rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
   flag=2 if request['operation']=='exchange' else 1
   if flag==1 and request['targetIdentity'] is not None:raise ValueError('No-replace requires an absent destination')
   if rename(left,os.fsencode(name),right,os.fsencode(target),flag)!=0:
    number=ctypes.get_errno();raise OSError(number,os.strerror(number))
   after_source=identity(left,name);after_target=identity(right,target)
   expected_source=request['targetIdentity'] if flag==2 else None
   if after_source!=expected_source or after_target!=request['sourceIdentity']:
    # Exchange never deletes either entry. If only the target raced and our
    # stage is still installed, return the independent entry to its path.
    if flag==2 and after_source is not None and after_target==request['sourceIdentity']:
     if rename(left,os.fsencode(name),right,os.fsencode(target),2)!=0:
      number=ctypes.get_errno();raise OSError(number,os.strerror(number))
    os.fsync(left);os.fsync(right)
    raise ValueError('Restore identity changed during atomic exchange; every entry is retained')
   os.fsync(left);os.fsync(right)
  finally:os.close(right)
 finally:os.close(left)

if __name__=='__main__':
 try:main()
 except Exception as error:
  print('Atomic brain restore refused: '+str(error),file=sys.stderr);sys.exit(1)
