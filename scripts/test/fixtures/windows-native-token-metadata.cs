using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
public static class BMNTokenMetadata {
 [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct GroupsHead { public uint Count; public SidAttributes First; }
 [StructLayout(LayoutKind.Sequential)] struct Privilege { public Luid Id; public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct Statistics {
  public Luid TokenId, AuthenticationId; public long ExpirationTime;
  public int TokenType, ImpersonationLevel; public uint DynamicCharged,DynamicAvailable,GroupCount,PrivilegeCount; public Luid ModifiedId;
 }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint bytes,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeName(string system,ref Luid id,StringBuilder name,ref uint length);
 sealed class QueryFailure : Win32Exception {
  public string Category,Context,Phase; public int Kind;
  public QueryFailure(string category,string context,int kind,string phase,int code):base(code){Category=category;Context=context;Kind=kind;Phase=phase;}
 }
 sealed class Probe {
  public string Context="current"; public List<object> Queries=new List<object>(),Closures=new List<object>();
  public bool Query(IntPtr token,int kind,IntPtr data,uint bytes,out uint needed,string phase,out int code) {
   bool success=GetTokenInformation(token,kind,data,bytes,out needed);code=success?0:Marshal.GetLastWin32Error();
   var row=new Dictionary<string,object>();row.Add("context",Context);row.Add("class",kind);row.Add("phase",phase);row.Add("requestedBytes",bytes);row.Add("requiredBytes",needed);row.Add("success",success);row.Add("nativeErrorCode",code);Queries.Add(row);return success;
  }
  public void Close(IntPtr handle,string role) {
   bool success=CloseHandle(handle);int code=success?0:Marshal.GetLastWin32Error();
   var row=new Dictionary<string,object>();row.Add("role",role);row.Add("success",success);row.Add("nativeErrorCode",code);Closures.Add(row);
  }
  public object Failure(Exception error) {
   var row=new Dictionary<string,object>();row.Add("exceptionType",error.GetType().Name);row.Add("hresult",error.HResult);
   var native=error as Win32Exception;row.Add("nativeErrorCode",native==null?(object)null:native.NativeErrorCode);
   var query=error as QueryFailure;row.Add("category",query==null?"metadata":query.Category);row.Add("context",query==null?Context:query.Context);
   if(query!=null){row.Add("class",query.Kind);row.Add("phase",query.Phase);}return row;
  }
 }
 sealed class Buffer : IDisposable {
  public IntPtr Data; public uint Bytes;
  public Buffer(IntPtr token,int kind,Probe probe) {
   uint needed;int error;bool first=probe.Query(token,kind,IntPtr.Zero,0,out needed,"size",out error);
   // Retain the original algorithm until a native diagnostic identifies the failing class.
   if(first || error!=122 || needed==0 || needed>1024*1024) throw new QueryFailure(!first && error!=122?"api":"buffer-policy",probe.Context,kind,"size",error);
   Bytes=needed;Data=Marshal.AllocHGlobal((int)needed);
   try {bool success=probe.Query(token,kind,Data,Bytes,out needed,"fill",out error);if(!success || needed>Bytes)throw new QueryFailure(success?"buffer-policy":"api",probe.Context,kind,"fill",error);}
   catch {Dispose();throw;}
  }
  public void Dispose(){if(Data!=IntPtr.Zero){Marshal.FreeHGlobal(Data);Data=IntPtr.Zero;}}
 }
 sealed class Context {
  public string User,Logon,Authentication;public uint Session;public Dictionary<string,object> Report;
 }
 static string Hash(string value) { using(var hash=SHA256.Create()) {return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").ToLowerInvariant();} }
 static uint Scalar(IntPtr token,int kind,Probe probe) {using(var b=new Buffer(token,kind,probe)){if(b.Bytes<4)throw new InvalidOperationException("short scalar");return unchecked((uint)Marshal.ReadInt32(b.Data));}}
 static string Sid(IntPtr value){return new SecurityIdentifier(value).Value;}
 static Context Read(IntPtr token,Probe probe) {
  var context=new Context();var report=new Dictionary<string,object>();context.Report=report;
  using(var b=new Buffer(token,1,probe)){if(b.Bytes<(uint)IntPtr.Size)throw new InvalidOperationException("short user");context.User=Sid(Marshal.ReadIntPtr(b.Data));}
  context.Session=Scalar(token,12,probe);report.Add("sessionId",context.Session);report.Add("userFingerprint",Hash(context.User));
  report.Add("tokenType",Scalar(token,8,probe));report.Add("elevationType",Scalar(token,18,probe));report.Add("elevated",Scalar(token,20,probe)!=0);report.Add("hasRestrictions",Scalar(token,21,probe)!=0);
  using(var b=new Buffer(token,25,probe)) {
   if(b.Bytes<(uint)Marshal.SizeOf(typeof(SidAttributes)))throw new InvalidOperationException("short integrity");
   var text=Sid(Marshal.ReadIntPtr(b.Data));var parts=text.Split('-');uint rid;
   if(!text.StartsWith("S-1-16-",StringComparison.Ordinal)||!uint.TryParse(parts[parts.Length-1],out rid))throw new InvalidOperationException("invalid integrity SID");
   report.Add("integrityRid",rid);
  }
  using(var b=new Buffer(token,10,probe)) {
   if(b.Bytes<(uint)Marshal.SizeOf(typeof(Statistics)))throw new InvalidOperationException("short statistics");
   var stats=(Statistics)Marshal.PtrToStructure(b.Data,typeof(Statistics));
   context.Authentication=stats.AuthenticationId.High.ToString("x8")+stats.AuthenticationId.Low.ToString("x8");report.Add("authenticationFingerprint",Hash(context.Authentication));
  }
  bool adminEnabled=false,adminDenyOnly=false;
  var groups=new List<object>();var restrictions=new List<object>();
  foreach(int kind in new[]{2,11}) using(var b=new Buffer(token,kind,probe)) {
   int offset=(int)Marshal.OffsetOf(typeof(GroupsHead),"First"),size=Marshal.SizeOf(typeof(SidAttributes));
   if(b.Bytes<4)throw new InvalidOperationException("short group count");uint count=unchecked((uint)Marshal.ReadInt32(b.Data));
   if(count>65536 || (count!=0 && (ulong)offset+(ulong)count*(uint)size>b.Bytes))throw new InvalidOperationException("invalid groups");
   for(uint index=0;index<count;index++) {
    var group=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(b.Data,offset+(int)index*size),typeof(SidAttributes));var sid=Sid(group.Sid);
    var item=new Dictionary<string,object>();item.Add("sidFingerprint",Hash(sid));item.Add("attributes",group.Attributes);
    item.Add("administrators",sid=="S-1-5-32-544");item.Add("enabled",(group.Attributes&4)!=0);item.Add("denyOnly",(group.Attributes&16)!=0);
    if(kind==2) {
     groups.Add(item);
     if(sid=="S-1-5-32-544"){adminEnabled=(group.Attributes&4)!=0;adminDenyOnly=(group.Attributes&16)!=0;}
     if((group.Attributes&0xc0000000)==0xc0000000){if(context.Logon!=null)throw new InvalidOperationException("ambiguous logon SID");context.Logon=sid;}
    }else restrictions.Add(item);
   }
  }
  report.Add("groups",groups);report.Add("restrictingSids",restrictions);report.Add("adminEnabled",adminEnabled);report.Add("adminDenyOnly",adminDenyOnly);
  report.Add("logonFingerprint",context.Logon==null?null:Hash(context.Logon));
  var privileges=new List<object>();
  using(var b=new Buffer(token,3,probe)) {
   if(b.Bytes<4)throw new InvalidOperationException("short privilege count");uint count=unchecked((uint)Marshal.ReadInt32(b.Data));int size=Marshal.SizeOf(typeof(Privilege));
   if(count>4096 || 4UL+(ulong)count*(uint)size>b.Bytes)throw new InvalidOperationException("invalid privileges");
   for(uint index=0;index<count;index++) {
    var privilege=(Privilege)Marshal.PtrToStructure(IntPtr.Add(b.Data,4+(int)index*size),typeof(Privilege));uint length=256;var name=new StringBuilder((int)length);
    if(!LookupPrivilegeName(null,ref privilege.Id,name,ref length))throw new Win32Exception();
    var item=new Dictionary<string,object>();item.Add("name",name.ToString());item.Add("attributes",privilege.Attributes);item.Add("enabled",(privilege.Attributes&2)!=0);privileges.Add(item);
   }
  }
  report.Add("privileges",privileges);return context;
 }
 public static object Collect() {
  var probe=new Probe();var result=new Dictionary<string,object>();result.Add("scope","token-metadata-only");result.Add("ownership","UNVERIFIED");result.Add("processMeasurementAllowed",false);
  IntPtr token=IntPtr.Zero,linked=IntPtr.Zero;object primaryFailure=null;bool cleanupSuccess=true;
  try {
   if(!OpenProcessToken(GetCurrentProcess(),8,out token)){int code=Marshal.GetLastWin32Error();throw new Win32Exception(code);}
   var current=Read(token,probe);result.Add("current",current.Report);
   try {
    probe.Context="linked-lookup";
    using(var b=new Buffer(token,19,probe)){if(b.Bytes<(uint)IntPtr.Size)throw new InvalidOperationException("short linked token");linked=Marshal.ReadIntPtr(b.Data);if(linked==IntPtr.Zero)throw new InvalidOperationException("null linked token");}
    probe.Context="linked";var other=Read(linked,probe);result.Add("linked",other.Report);result.Add("sameUser",current.User==other.User);result.Add("sameLogon",current.Logon!=null&&current.Logon==other.Logon);result.Add("sameAuthenticationId",current.Authentication==other.Authentication);result.Add("sameSession",current.Session==other.Session);
   }catch(QueryFailure error){
    result.Add("linkedFailure",probe.Failure(error));
    if(error.Context=="linked-lookup" && error.Kind==19 && error.Category=="api")result.Add("linkedUnavailableWin32Code",error.NativeErrorCode);
    else primaryFailure=probe.Failure(error);
   }
  }catch(Exception error){primaryFailure=probe.Failure(error);}
  finally {
   if(linked!=IntPtr.Zero)probe.Close(linked,"linked");
   if(token!=IntPtr.Zero)probe.Close(token,"current");
  }
  foreach(Dictionary<string,object> row in probe.Closures)if(!(bool)row["success"])cleanupSuccess=false;
  result.Add("queries",probe.Queries);result.Add("handleClosures",probe.Closures);result.Add("primaryFailure",primaryFailure);result.Add("cleanupSuccess",cleanupSuccess);result.Add("completed",primaryFailure==null && cleanupSuccess);return result;
 }
}
