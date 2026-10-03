// Disposable CI only. A real second-user AppContainer, never a simulated token.
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <lm.h>
#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <stdexcept>
#include <cstdlib>

namespace fs = std::filesystem;
static const wchar_t* capability = L"S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417";
static const char* stage = "start";
struct Failure { DWORD code; };
static void check(bool ok) { if (!ok) throw Failure{GetLastError()}; }
static void checkCode(DWORD code) { if (code) throw Failure{code}; }
static void checkHr(HRESULT result) { if (FAILED(result)) throw Failure{static_cast<DWORD>(result)}; }
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle() = default;
  explicit Handle(HANDLE v) : value(v) {}
  Handle(const Handle&) = delete;
};
struct LocalMemory {
  void* value = nullptr;
  ~LocalMemory() { if (value) LocalFree(value); }
};
static std::wstring sidText(PSID sid) {
  LPWSTR value = nullptr;
  check(ConvertSidToStringSidW(sid, &value));
  std::wstring result(value); LocalFree(value); return result;
}
static std::string ascii(const std::wstring& text) {
  std::string out;
  for (wchar_t value : text) {
    if (value > 127) throw Failure{ERROR_INVALID_DATA};
    out += static_cast<char>(value);
  }
  return out;
}
static std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  check(GetTokenInformation(token, kind, buffer.data(), size, &size)); return buffer;
}
static std::wstring currentSid() {
  Handle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value));
  auto info = tokenInfo(token.value, TokenUser);
  return sidText(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid);
}
static void acl(const fs::path& path, const std::wstring& dacl, bool low = false) {
  LocalMemory descriptor;
  const std::wstring sddl = dacl + (low ? L"S:(ML;OICI;NW;;;LW)" : L"");
  check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
    &descriptor.value, nullptr));
  PACL access = nullptr, label = nullptr; BOOL present = FALSE, defaulted = FALSE;
  check(GetSecurityDescriptorDacl(descriptor.value, &present, &access, &defaulted));
  if (low) check(GetSecurityDescriptorSacl(descriptor.value, &present, &label, &defaulted));
  checkCode(SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | (low ? LABEL_SECURITY_INFORMATION : 0),
    nullptr, nullptr, access, label));
}
static void write(const fs::path& path, const std::string& text) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  stream << text; stream.close();
  if (!stream) throw Failure{ERROR_WRITE_FAULT};
}
static std::string read(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) throw Failure{ERROR_FILE_NOT_FOUND};
  return std::string(std::istreambuf_iterator<char>(stream), {});
}
static void publish(const fs::path& path, const std::string& text) {
  const fs::path temporary = path.wstring() + L".tmp";
  write(temporary, text);
  check(MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH));
}
static std::wstring quote(const std::wstring& text) {
  // Only generated SID/moniker values and fixture paths without quotes are used.
  if (text.find(L'"') != std::wstring::npos || (!text.empty() && text.back() == L'\\')) throw Failure{ERROR_INVALID_PARAMETER};
  return L"\"" + text + L"\"";
}
static DWORD accessFile(const fs::path& path, bool writing) {
  Handle file(CreateFileW(path.c_str(), writing ? GENERIC_WRITE : GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return GetLastError();
  char byte = 'Z'; DWORD count = 0;
  BOOL ok = writing ? WriteFile(file.value, &byte, 1, &count, nullptr) : ReadFile(file.value, &byte, 1, &count, nullptr);
  if (!ok) return GetLastError();
  return count == 1 ? ERROR_SUCCESS : ERROR_READ_FAULT;
}
static std::wstring randomHex() {
  BYTE bytes[16]; checkCode(static_cast<DWORD>(BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG)));
  std::wstring out; const wchar_t* hex = L"0123456789abcdef";
  for (BYTE value : bytes) { out += hex[value >> 4]; out += hex[value & 15]; } return out;
}
static void ownJob(Handle& job) {
  job.value = CreateJobObjectW(nullptr, nullptr); check(job.value != nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &info, sizeof(info)));
}
static DWORD finish(Handle& process, Handle& job, DWORD timeout) {
  DWORD wait = WaitForSingleObject(process.value, timeout);
  if (wait != WAIT_OBJECT_0) {
    TerminateJobObject(job.value, 99); WaitForSingleObject(process.value, 5000);
    throw Failure{wait == WAIT_TIMEOUT ? WAIT_TIMEOUT : GetLastError()};
  }
  DWORD exit = 0; check(GetExitCodeProcess(process.value, &exit)); return exit;
}

static bool removeProfile(const std::wstring& sid, DWORD& error) {
  const auto deadline = GetTickCount64() + 5000;
  do {
    if (DeleteProfileW(sid.c_str(), nullptr, nullptr)) { error = 0; return true; }
    error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return true;
    if (error != ERROR_SHARING_VIOLATION && error != ERROR_BUSY) return false;
    Sleep(100);
  } while (GetTickCount64() < deadline);
  return false;
}
static int rescue(const fs::path& base) {
  const auto identity = base / L"generated-account.txt";
  if (!fs::exists(identity)) return 0;
  std::istringstream input(read(identity)); std::string nameText, sidString;
  std::getline(input, nameText); std::getline(input, sidString);
  if (nameText.size() != 16 || nameText.substr(0, 6) != "bmncap" || nameText.find_first_not_of("0123456789abcdef", 6) != std::string::npos)
    throw Failure{ERROR_INVALID_DATA};
  const std::wstring name(nameText.begin(), nameText.end()); std::wstring sid(sidString.begin(), sidString.end());
  DWORD size = 0, domainSize = 0; SID_NAME_USE use;
  LookupAccountNameW(nullptr, name.c_str(), nullptr, &size, nullptr, &domainSize, &use);
  if (size) {
    std::vector<BYTE> found(size); std::vector<wchar_t> domain(domainSize);
    check(LookupAccountNameW(nullptr, name.c_str(), found.data(), &size, domain.data(), &domainSize, &use));
    const auto actual = sidText(found.data());
    if (!sid.empty() && actual != sid) throw Failure{ERROR_BAD_TOKEN_TYPE};
    sid = actual;
  } else if (GetLastError() != ERROR_NONE_MAPPED) throw Failure{GetLastError()};
  if (!sid.empty()) {
    if (sid == currentSid() || sid.rfind(L"S-1-5-21-", 0) != 0) throw Failure{ERROR_BAD_TOKEN_TYPE};
    DWORD error = 0; if (!removeProfile(sid, error)) throw Failure{error};
  }
  const DWORD removed = NetUserDel(nullptr, name.c_str());
  if (removed != NERR_Success && removed != NERR_UserNotFound) throw Failure{removed};
  return 0;
}

static int receiver(const fs::path& base, const std::wstring& expectedUser, const std::wstring& expectedPackage, bool withCapability) {
  stage = "receiver-token";
  Handle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value));
  auto user = tokenInfo(token.value, TokenUser);
  auto container = tokenInfo(token.value, TokenIsAppContainer);
  auto package = tokenInfo(token.value, TokenAppContainerSid);
  auto capabilities = tokenInfo(token.value, TokenCapabilities);
  auto integrity = tokenInfo(token.value, TokenIntegrityLevel);
  bool userMatches = sidText(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid) == expectedUser;
  bool isContainer = *reinterpret_cast<DWORD*>(container.data()) != 0;
  auto appSid = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(package.data())->TokenAppContainer;
  bool packageMatches = appSid && sidText(appSid) == expectedPackage;
  auto groups = reinterpret_cast<TOKEN_GROUPS*>(capabilities.data()); bool hasCapability = false;
  for (DWORD i = 0; i < groups->GroupCount; ++i)
    if (sidText(groups->Groups[i].Sid) == capability && (groups->Groups[i].Attributes & SE_GROUP_ENABLED)) hasCapability = true;
  auto label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  DWORD level = *GetSidSubAuthority(label, *GetSidSubAuthorityCount(label) - 1);
  bool facts = userMatches && isContainer && packageMatches && hasCapability == withCapability && level <= SECURITY_MANDATORY_LOW_RID;
  bool passed = facts;
  std::ostringstream result;
  result << "{\"tokenUserMatches\":" << (userMatches ? "true" : "false")
    << ",\"appContainer\":" << (isContainer ? "true" : "false")
    << ",\"packageMatches\":" << (packageMatches ? "true" : "false")
    << ",\"capabilityPresent\":" << (hasCapability ? "true" : "false")
    << ",\"integrityRid\":" << level << ",\"access\":[";
  const std::vector<std::pair<std::string, fs::path>> cases = {
    {"control", base / L"public/capability-control.txt"},
    {"strict", base / L"private/strict.txt"},
    {"cache", base / L"private/Cache/cache.txt"},
    {"diagnosticLow", base / L"public/diagnostic-low.txt"}
  };
  for (size_t i = 0; i < cases.size(); ++i) {
    auto readError = accessFile(cases[i].second, false), writeError = accessFile(cases[i].second, true);
    const DWORD expected = i == 0 && withCapability ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    passed = passed && readError == expected && writeError == expected;
    if (i) result << ',';
    result << "{\"name\":\"" << cases[i].first << "\",\"readError\":" << readError << ",\"writeError\":" << writeError << '}';
  }
  result << "],\"passed\":" << (passed ? "true" : "false") << '}';
  publish(base / L"public/results" / (withCapability ? L"with.json" : L"without.json"), result.str());
  return passed ? 0 : 1;
}

static int broker(const fs::path& executable, const fs::path& base, const std::wstring& user, const std::wstring& owner, const std::wstring& moniker) {
  stage = "broker-user";
  if (currentSid() != user) throw Failure{ERROR_BAD_TOKEN_TYPE};
  checkCode(accessFile(base / L"public/ordinary-control.txt", false));
  checkCode(accessFile(base / L"public/ordinary-control.txt", true));
  PSID package = nullptr; bool created = false; DWORD error = 0; bool passed = true;
  std::string profileFacts = "null";
  try {
    stage = "broker-profile";
    Handle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value));
    DWORD length = 0; GetUserProfileDirectoryW(token.value, nullptr, &length);
    std::vector<wchar_t> profile(length); check(GetUserProfileDirectoryW(token.value, profile.data(), &length));
    const fs::path local = fs::path(profile.data()) / L"AppData" / L"Local";
    const fs::path probePath = local / (L"bmn-probe-" + moniker + L".tmp");
    DWORD fileError = 0;
    { Handle probe(CreateFileW(probePath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
      if (probe.value == INVALID_HANDLE_VALUE) fileError = GetLastError(); }
    HKEY current = nullptr, probeKey = nullptr;
    LSTATUS registryError = RegOpenCurrentUser(KEY_READ | KEY_WRITE, &current);
    if (registryError == ERROR_SUCCESS) {
      const auto key = L"Software\\BMNCapabilityProbe\\" + moniker;
      DWORD disposition = 0;
      registryError = RegCreateKeyExW(current, key.c_str(), 0, nullptr, 0, KEY_READ | KEY_WRITE, nullptr, &probeKey, &disposition);
      if (registryError == ERROR_SUCCESS) { RegCloseKey(probeKey); if (disposition == REG_CREATED_NEW_KEY) RegDeleteKeyW(current, key.c_str()); }
      RegCloseKey(current);
    }
    wchar_t environmentLocal[32768]{};
    const DWORD localLength = GetEnvironmentVariableW(L"LOCALAPPDATA", environmentLocal, 32768);
    bool environmentMatches = localLength > 0 && localLength < 32768 &&
      CompareStringOrdinal(environmentLocal, -1, local.c_str(), -1, TRUE) == CSTR_EQUAL;
    auto elevated = tokenInfo(token.value, TokenElevation);
    profileFacts = "{\"localFileProbeError\":" + std::to_string(fileError) + ",\"registryProbeError\":" + std::to_string(registryError)
      + ",\"environmentLocalMatchesProfile\":" + (environmentMatches ? "true" : "false")
      + ",\"elevated\":" + (reinterpret_cast<TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated ? "true" : "false") + "}";
    stage = "create-appcontainer";
    checkHr(CreateAppContainerProfile(moniker.c_str(), moniker.c_str(), L"BMN synthetic capability acceptance", nullptr, 0, &package));
    created = true;
    const auto packageText = sidText(package);
    acl(base / L"public/results", L"D:P(A;OICI;FA;;;" + owner + L")(A;OICI;FA;;;" + user + L")(A;OICI;FA;;;" + packageText + L")", true);
    LocalMemory cap; check(ConvertStringSidToSidW(capability, &cap.value));
    for (bool enabled : {true, false}) {
      stage = "launch-appcontainer";
      SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
      std::vector<BYTE> storage(size);
      auto attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
      check(InitializeProcThreadAttributeList(attributes, 1, 0, &size));
      struct Cleanup { PPROC_THREAD_ATTRIBUTE_LIST value; ~Cleanup() { DeleteProcThreadAttributeList(value); } } cleanup{attributes};
      SID_AND_ATTRIBUTES entry{cap.value, SE_GROUP_ENABLED};
      SECURITY_CAPABILITIES caps{package, enabled ? &entry : nullptr, enabled ? 1UL : 0UL, 0};
      check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &caps, sizeof(caps), nullptr, nullptr));
      STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
      std::wstring command = quote(executable.wstring()) + L" --receiver " + quote(base.wstring()) + L" " + quote(user) + L" " + quote(packageText) + (enabled ? L" 1" : L" 0");
      PROCESS_INFORMATION child{}; Handle job; ownJob(job);
      check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, (base / L"public").c_str(), &startup.StartupInfo, &child));
      Handle process(child.hProcess), thread(child.hThread);
      if (!AssignProcessToJobObject(job.value, process.value)) {
        const DWORD assignError = GetLastError(); TerminateProcess(process.value, 99); WaitForSingleObject(process.value, 5000); throw Failure{assignError};
      }
      check(ResumeThread(thread.value) != static_cast<DWORD>(-1));
      passed = finish(process, job, 20000) == 0 && passed;
    }
  } catch (const Failure& failure) { error = failure.code; }
  catch (...) { error = ERROR_UNHANDLED_EXCEPTION; }
  const char* failedStage = stage;
  HRESULT removed = created ? DeleteAppContainerProfile(moniker.c_str()) : S_OK;
  if (package) FreeSid(package);
  publish(base / L"public/broker.json", "{\"error\":" + std::to_string(error) + ",\"stage\":\"" + failedStage
    + "\",\"profile\":" + profileFacts + ",\"appContainerRemoved\":" + (SUCCEEDED(removed) ? "true" : "false") + "}");
  return error == 0 && SUCCEEDED(removed) && passed ? 0 : 1;
}

static int supervisor(const fs::path& executable, const fs::path& base) {
  const auto suffix = randomHex(), name = L"bmncap" + suffix.substr(0, 10), password = L"Bm9!" + randomHex();
  const auto owner = currentSid(), moniker = L"BMN.Capability." + suffix;
  std::wstring user; bool created = false; DWORD error = 0, profileError = 0, accountError = 0; int brokerExit = -1;
  bool userRemoved = false, profileRemoved = false; const char* failedStage = "none";
  try {
    stage = "create-user";
    USER_INFO_1 info{}; info.usri1_name = const_cast<LPWSTR>(name.c_str()); info.usri1_password = const_cast<LPWSTR>(password.c_str());
    info.usri1_priv = USER_PRIV_USER; info.usri1_flags = UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD;
    DWORD parameter = 0; checkCode(NetUserAdd(nullptr, 1, reinterpret_cast<LPBYTE>(&info), &parameter)); created = true;
    publish(base / L"generated-account.txt", ascii(name) + "\n");
    DWORD sidSize = 0, domainSize = 0; SID_NAME_USE use;
    LookupAccountNameW(nullptr, name.c_str(), nullptr, &sidSize, nullptr, &domainSize, &use);
    std::vector<BYTE> sid(sidSize); std::vector<wchar_t> domain(domainSize);
    check(LookupAccountNameW(nullptr, name.c_str(), sid.data(), &sidSize, domain.data(), &domainSize, &use)); user = sidText(sid.data());
    publish(base / L"generated-account.txt", ascii(name) + "\n" + ascii(user) + "\n");
    LocalMemory usersSid; check(ConvertStringSidToSidW(L"S-1-5-32-545", &usersSid.value));
    wchar_t group[256], groupDomain[256]; DWORD groupSize = 256, groupDomainSize = 256;
    check(LookupAccountSidW(nullptr, usersSid.value, group, &groupSize, groupDomain, &groupDomainSize, &use));
    wchar_t computer[256]; DWORD computerSize = 256; check(GetComputerNameW(computer, &computerSize));
    std::wstring memberName = std::wstring(computer) + L"\\" + name;
    LOCALGROUP_MEMBERS_INFO_3 member{const_cast<LPWSTR>(memberName.c_str())};
    checkCode(NetLocalGroupAddMembers(nullptr, group, 3, reinterpret_cast<LPBYTE>(&member), 1));
    stage = "prepare-fixtures";
    acl(base, L"D:P(A;OICI;FA;;;" + owner + L")(A;;GRGX;;;" + user + L")(A;;GRGX;;;S-1-15-2-1)");
    acl(base / L"public", L"D:P(A;OICI;FA;;;" + owner + L")(A;OICI;FA;;;" + user + L")(A;OICI;GRGX;;;S-1-15-2-1)", true);
    fs::create_directory(base / L"public/results");
    fs::create_directory(base / L"private/Cache");
    acl(base / L"private/Cache", L"D:P(A;OICI;FA;;;" + owner + L")(A;;0x1301bf;;;" + capability + L")(A;OICIIO;0xe0010000;;;" + capability + L")");
    for (auto path : {L"private/strict.txt", L"private/Cache/cache.txt", L"public/diagnostic-low.txt", L"public/capability-control.txt", L"public/ordinary-control.txt"})
      write(base / path, "synthetic-data");
    acl(base / L"public/diagnostic-low.txt", L"D:P(A;;FA;;;" + owner + L")(A;;0x1301bf;;;" + capability + L")", true);
    acl(base / L"public/capability-control.txt", L"D:P(A;;FA;;;" + owner + L")(A;;FA;;;" + user + L")(A;;0x1301bf;;;" + capability + L")", true);
    for (auto path : {L"private/strict.txt", L"private/Cache/cache.txt", L"public/diagnostic-low.txt"}) {
      checkCode(accessFile(base / path, false)); checkCode(accessFile(base / path, true));
    }
    publish(base / L"prepared.json", "{\"ownerPositiveControls\":true}");
    stage = "validate-real-storage-guard";
    const auto deadline = GetTickCount64() + 60000;
    while (!fs::exists(base / L"go")) {
      if (fs::exists(base / L"abort") || GetTickCount64() > deadline) throw Failure{ERROR_OPERATION_ABORTED};
      Sleep(50);
    }
    stage = "launch-second-user-broker";
    std::wstring command = quote(executable.wstring()) + L" --broker " + quote(base.wstring()) + L" " + quote(user) + L" " + quote(owner) + L" " + quote(moniker);
    if (command.size() >= 1024) throw Failure{ERROR_FILENAME_EXCED_RANGE};
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{}; Handle job; ownJob(job);
    check(CreateProcessWithLogonW(name.c_str(), L".", password.c_str(), LOGON_WITH_PROFILE, executable.c_str(), command.data(),
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr, (base / L"public").c_str(), &startup, &child));
    Handle process(child.hProcess), thread(child.hThread);
    if (!AssignProcessToJobObject(job.value, process.value)) {
      const DWORD assignError = GetLastError(); TerminateProcess(process.value, 99); WaitForSingleObject(process.value, 5000); throw Failure{assignError};
    }
    check(ResumeThread(thread.value) != static_cast<DWORD>(-1));
    brokerExit = static_cast<int>(finish(process, job, 60000));
    check(TerminateJobObject(job.value, 99));
  } catch (const Failure& failure) { error = failure.code; failedStage = stage; }
  catch (...) { error = ERROR_UNHANDLED_EXCEPTION; failedStage = stage; }
  // Only the newly generated SID can be removed. No owner profile is touched.
  if (!user.empty()) {
    profileRemoved = removeProfile(user, profileError);
  }
  if (created) { accountError = NetUserDel(nullptr, name.c_str()); userRemoved = accountError == NERR_Success; }
  std::string with = "null", without = "null", brokerRecord = "null";
  try { with = read(base / L"public/results/with.json"); } catch (...) {}
  try { without = read(base / L"public/results/without.json"); } catch (...) {}
  try { brokerRecord = read(base / L"public/broker.json"); } catch (...) {}
  bool passed = error == 0 && brokerExit == 0 && userRemoved && profileRemoved;
  publish(base / L"result.json", "{\"passed\":" + std::string(passed ? "true" : "false") + ",\"stage\":\"" + failedStage + "\",\"error\":" + std::to_string(error)
    + ",\"brokerExit\":" + std::to_string(brokerExit) + ",\"accountRemoved\":" + (userRemoved ? "true" : "false") + ",\"userProfileRemoved\":" + (profileRemoved ? "true" : "false")
    + ",\"profileCleanupError\":" + std::to_string(profileError) + ",\"accountCleanupError\":" + std::to_string(accountError)
    + ",\"broker\":" + brokerRecord + ",\"withCapability\":" + with + ",\"withoutCapability\":" + without + "}");
  return passed ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 3) return 2;
    const fs::path executable = fs::absolute(argv[0]), base = fs::absolute(argv[2]);
    if ((std::wstring(argv[1]) == L"--supervisor" || std::wstring(argv[1]) == L"--cleanup") && argc == 3) {
      wchar_t ci[6]{};
      if (GetEnvironmentVariableW(L"GITHUB_ACTIONS", ci, 6) != 4 || std::wstring(ci) != L"true") return 2;
      return std::wstring(argv[1]) == L"--cleanup" ? rescue(base) : supervisor(executable, base);
    }
    if (std::wstring(argv[1]) == L"--broker" && argc == 6) return broker(executable, base, argv[3], argv[4], argv[5]);
    if (std::wstring(argv[1]) == L"--receiver" && argc == 6) return receiver(base, argv[3], argv[4], std::wstring(argv[5]) == L"1");
    return 2;
  } catch (const Failure& error) {
    fprintf(stderr, "BMN_CAPABILITY_STAGE=%s ERROR=%lu\n", stage, error.code); return 3;
  } catch (...) { fprintf(stderr, "BMN_CAPABILITY_STAGE=%s ERROR=unknown\n", stage); return 4; }
}
