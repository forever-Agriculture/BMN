// Set and verify the Start-menu identity required for desktop toast attribution.
// https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shobjidl.h>
#include <initguid.h>
#include <propkey.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <stdio.h>
#include <wchar.h>

using Microsoft::WRL::ComPtr;
static const wchar_t* appId = L"dev.bmn.desktop";
static HRESULT writeShortcut(const wchar_t* target, const wchar_t* directory, const wchar_t* path) {
  ComPtr<IShellLinkW> link;
  HRESULT status = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link));
  if (FAILED(status)) return status;
  if (FAILED(status = link->SetPath(target)) || FAILED(status = link->SetWorkingDirectory(directory)) ||
      FAILED(status = link->SetArguments(L"")) || FAILED(status = link->SetDescription(L"BMN")) ||
      FAILED(status = link->SetIconLocation(target, 0))) return status;
  ComPtr<IPropertyStore> properties;
  if (FAILED(status = link.As(&properties))) return status;
  PROPVARIANT value;
  PropVariantInit(&value);
  status = InitPropVariantFromString(appId, &value);
  if (SUCCEEDED(status)) status = properties->SetValue(PKEY_AppUserModel_ID, value);
  PropVariantClear(&value);
  if (FAILED(status) || FAILED(status = properties->Commit())) return status;
  ComPtr<IPersistFile> file;
  if (FAILED(status = link.As(&file))) return status;
  return file->Save(path, TRUE);
}
static HRESULT verifyShortcut(const wchar_t* target, const wchar_t* path) {
  ComPtr<IShellLinkW> link;
  HRESULT status = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link));
  if (FAILED(status)) return status;
  ComPtr<IPersistFile> file;
  if (FAILED(status = link.As(&file)) || FAILED(status = file->Load(path, STGM_READ))) return status;
  wchar_t actual[32768];
  if (FAILED(status = link->GetPath(actual, 32768, nullptr, SLGP_RAWPATH))) return status;
  if (CompareStringOrdinal(actual, -1, target, -1, TRUE) != CSTR_EQUAL) return E_FAIL;
  ComPtr<IPropertyStore> properties;
  if (FAILED(status = link.As(&properties))) return status;
  PROPVARIANT value;
  PropVariantInit(&value);
  status = properties->GetValue(PKEY_AppUserModel_ID, &value);
  if (SUCCEEDED(status) && (value.vt != VT_LPWSTR || !value.pwszVal || wcscmp(value.pwszVal, appId) != 0)) status = E_FAIL;
  PropVariantClear(&value);
  return status;
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 4) return 2;
  HRESULT status = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(status)) return 1;
  // A same-named shortcut belonging to another program is not ours to replace.
  DWORD attributes = GetFileAttributesW(argv[3]);
  if (attributes != INVALID_FILE_ATTRIBUTES) {
    if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) status = E_ACCESSDENIED;
    else status = verifyShortcut(argv[1], argv[3]);
  } else if (GetLastError() != ERROR_FILE_NOT_FOUND) status = HRESULT_FROM_WIN32(GetLastError());
  if (SUCCEEDED(status)) status = writeShortcut(argv[1], argv[2], argv[3]);
  if (SUCCEEDED(status)) status = verifyShortcut(argv[1], argv[3]);
  CoUninitialize();
  if (FAILED(status)) { fwprintf(stderr, L"BMN shortcut verification failed (HRESULT %08lx).\n", static_cast<unsigned long>(status)); return 1; }
  return 0;
}
