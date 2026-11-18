# MODULE: brain-files.test.py - Actual kernel exchange with a replacement after the helper identity check
import ctypes,importlib.util,io,json,os,tempfile,unittest,sys
sys.dont_write_bytecode=True
from pathlib import Path
from unittest.mock import patch
script=Path(__file__).resolve().parents[2]/'apps/desktop/bin/brain-cutover-files.py'
spec=importlib.util.spec_from_file_location('brain_restore_files',script);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class AtomicRestoreRace(unittest.TestCase):
 def test_replacement_in_the_final_identity_to_syscall_gap_survives_at_its_original_path(self):
  with tempfile.TemporaryDirectory(prefix='bmn-brain-kernel-race-')as folder:
   root=Path(folder);source=root/'stage';target=root/'target';kept=root/'kept-owned'
   source.write_text('Original synthetic rules');target.write_text('Owned switched rules')
   identity=lambda path:{'dev':path.lstat().st_dev,'ino':path.lstat().st_ino}
   request={'operation':'exchange','source':str(source),'target':str(target),'sourceIdentity':identity(source),'targetIdentity':identity(target)}
   library=ctypes.CDLL(None,use_errno=True);real=library.renameat2
   real.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];real.restype=ctypes.c_int
   calls=0
   def exchange(*args):
    nonlocal calls
    calls+=1
    if calls==1:
     target.rename(kept);target.write_text('Independent final-gap replacement');target.chmod(0o400)
    return real(*args)
   class Library:renameat2=staticmethod(exchange)
   with patch.object(module.ctypes,'CDLL',return_value=Library()),patch.object(module.sys,'stdin',io.StringIO(json.dumps(request))):
    with self.assertRaisesRegex(ValueError,'changed during atomic exchange'):module.main()
   self.assertEqual(target.read_text(),'Independent final-gap replacement');self.assertEqual(target.stat().st_mode&0o777,0o400)
   self.assertEqual(source.read_text(),'Original synthetic rules');self.assertEqual(kept.read_text(),'Owned switched rules')
if __name__=='__main__':unittest.main()
