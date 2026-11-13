#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

namespace {

namespace fs = std::filesystem;

void showError(const std::wstring& message) {
  MessageBoxW(nullptr, message.c_str(), L"PDF-Scrubber could not start", MB_OK | MB_ICONERROR);
}

std::wstring windowsErrorMessage(DWORD error) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
    FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    nullptr,
    error,
    MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
    reinterpret_cast<wchar_t*>(&buffer),
    0,
    nullptr
  );
  std::wstring result = length > 0 && buffer != nullptr
    ? std::wstring(buffer, length)
    : L"Windows error " + std::to_wstring(error);
  if (buffer != nullptr) LocalFree(buffer);
  while (!result.empty() && (result.back() == L'\r' || result.back() == L'\n')) result.pop_back();
  return result;
}

bool inspectPath(const fs::path& path, bool requireDirectory, bool requireFile) {
  HANDLE handle = CreateFileW(
    path.c_str(),
    FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr
  );
  if (handle == INVALID_HANDLE_VALUE) return false;

  FILE_ATTRIBUTE_TAG_INFO information{};
  const bool inspected = GetFileInformationByHandleEx(
    handle,
    FileAttributeTagInfo,
    &information,
    sizeof(information)
  ) != 0;
  CloseHandle(handle);
  if (!inspected || (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  if (requireDirectory && (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
  if (requireFile && (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) return false;
  return true;
}

bool isSafeDirectory(const fs::path& path) {
  const fs::path absolute = fs::absolute(path).lexically_normal();
  fs::path current = absolute.root_path();
  if (current.empty() || !inspectPath(current, true, false)) return false;
  for (const auto& component : absolute.relative_path()) {
    current /= component;
    if (!inspectPath(current, true, false)) return false;
  }
  return true;
}

bool isSafeRegularFile(const fs::path& path) {
  const fs::path absolute = fs::absolute(path).lexically_normal();
  if (!isSafeDirectory(absolute.parent_path())) return false;
  return inspectPath(absolute, false, true);
}

bool ensureStorageDirectory(const fs::path& parent, const wchar_t* leaf, fs::path& result) {
  if (!isSafeDirectory(parent)) return false;
  result = parent / leaf;
  if (!CreateDirectoryW(result.c_str(), nullptr)) {
    const DWORD error = GetLastError();
    if (error != ERROR_ALREADY_EXISTS) return false;
  }
  return isSafeDirectory(result);
}

bool hasDirectoryWriteAccess(const fs::path& directory, bool allowSubdirectories) {
  DWORD requestedAccess = FILE_READ_ATTRIBUTES | FILE_ADD_FILE;
  if (allowSubdirectories) requestedAccess |= FILE_ADD_SUBDIRECTORY;
  HANDLE handle = CreateFileW(
    directory.c_str(),
    requestedAccess,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr
  );
  if (handle == INVALID_HANDLE_VALUE) return false;

  FILE_ATTRIBUTE_TAG_INFO information{};
  const bool inspected = GetFileInformationByHandleEx(
    handle,
    FileAttributeTagInfo,
    &information,
    sizeof(information)
  ) != 0;
  CloseHandle(handle);
  return inspected
    && (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
    && (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool validateOptionalSettingsFile(const fs::path& path) {
  HANDLE handle = CreateFileW(
    path.c_str(),
    FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT,
    nullptr
  );
  if (handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      return true;
    }
    return false;
  }

  FILE_ATTRIBUTE_TAG_INFO information{};
  const bool inspected = GetFileInformationByHandleEx(
    handle,
    FileAttributeTagInfo,
    &information,
    sizeof(information)
  ) != 0;
  CloseHandle(handle);
  return inspected
    && (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
    && (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool validateLayout(const fs::path& root, const fs::path& launcherPath, fs::path& innerExecutable,
                    fs::path& profile, fs::path& temp, fs::path& logs, fs::path& crashes,
                    std::wstring& failure) {
  if (!isSafeDirectory(root)) {
    failure = L"The application folder is missing or contains a Windows reparse point. Re-extract the complete PDF-Scrubber archive to a normal folder.";
    return false;
  }
  if (!isSafeRegularFile(launcherPath)) {
    failure = L"The root PDF-Scrubber.exe is not a regular file. Re-extract the complete application archive.";
    return false;
  }

  const fs::path config = root / L"config";
  const fs::path runtime = config / L"runtime";
  innerExecutable = runtime / L"PDF-Scrubber.exe";
  if (!isSafeDirectory(config) || !isSafeDirectory(runtime)
      || !isSafeRegularFile(innerExecutable)) {
    failure = L"The packaged Electron runtime is missing or unsafe. Re-extract the complete PDF-Scrubber archive; do not copy only the root EXE.";
    return false;
  }

  const fs::path settings = root / L"settings.json";
  if (!validateOptionalSettingsFile(settings)) {
    failure = L"settings.json must be an accessible regular file, not a link or Windows reparse point.";
    return false;
  }

  if (!ensureStorageDirectory(config, L"profile", profile)
      || !ensureStorageDirectory(config, L"temp", temp)
      || !ensureStorageDirectory(config, L"logs", logs)
      || !ensureStorageDirectory(config, L"crashes", crashes)) {
    failure = L"Portable storage folders could not be created or contain a Windows reparse point. Move the complete application folder to a writable location.";
    return false;
  }
  if (!hasDirectoryWriteAccess(root, false)) {
    failure = L"The application folder is not writable. Move the complete PDF-Scrubber folder to a writable location; do not run it as administrator.";
    return false;
  }
  if (!hasDirectoryWriteAccess(profile, true)
      || !hasDirectoryWriteAccess(temp, true)) {
    failure = L"The portable profile or temporary storage folder is not writable. Move the complete application folder to a writable location.";
    return false;
  }
  return true;
}

std::wstring lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

bool isConflictingSwitch(const std::wstring& argument) {
  if (argument.size() < 3 || argument[0] != L'-' || argument[1] != L'-') return false;
  const std::size_t equals = argument.find(L'=');
  const std::wstring name = lower(argument.substr(2, equals == std::wstring::npos
    ? std::wstring::npos
    : equals - 2));
  static const std::vector<std::wstring> forbidden = {
    L"user-data-dir",
    L"session-data-dir",
    L"disk-cache-dir",
    L"crash-dumps-dir",
    L"crash-reporter-directory",
    L"log-file",
    L"enable-logging",
    L"log-severity",
    L"vmodule",
    L"trace-to-file",
    L"trace-to-file-name",
    L"trace-config-file",
  };
  return std::find(forbidden.begin(), forbidden.end(), name) != forbidden.end();
}

std::wstring quoteArgument(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return argument;
  }

  std::wstring quoted = L"\"";
  std::size_t backslashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'\"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

bool isFilteredEnvironmentVariable(const std::wstring& name) {
  const std::wstring normalized = lower(name);
  return normalized == L"electron_run_as_node"
    || normalized == L"electron_enable_logging"
    || normalized == L"electron_log_file"
    || normalized == L"chrome_log_file";
}

void setEnvironmentValue(std::vector<std::pair<std::wstring, std::wstring>>& variables,
                         const std::wstring& name, const std::wstring& value) {
  const std::wstring normalizedName = lower(name);
  const auto found = std::find_if(variables.begin(), variables.end(), [&](const auto& entry) {
    return lower(entry.first) == normalizedName;
  });
  if (found == variables.end()) variables.emplace_back(name, value);
  else found->second = value;
}

std::vector<wchar_t> childEnvironment(const fs::path& root, const fs::path& temp) {
  std::vector<std::pair<std::wstring, std::wstring>> variables;
  LPWCH inherited = GetEnvironmentStringsW();
  if (inherited == nullptr) return {};

  for (const wchar_t* entry = inherited; *entry != L'\0'; entry += std::wcslen(entry) + 1) {
    std::wstring value(entry);
    const std::size_t separator = value.find(L'=', value[0] == L'=' ? 1 : 0);
    if (separator == std::wstring::npos) continue;
    const std::wstring name = value.substr(0, separator);
    const std::wstring contents = value.substr(separator + 1);
    if (!isFilteredEnvironmentVariable(name)) variables.emplace_back(name, contents);
  }
  FreeEnvironmentStringsW(inherited);

  setEnvironmentValue(variables, L"PDF_SCRUBBER_PORTABLE_ROOT", root.native());
  setEnvironmentValue(variables, L"TMP", temp.native());
  setEnvironmentValue(variables, L"TEMP", temp.native());
  setEnvironmentValue(variables, L"TMPDIR", temp.native());
  std::sort(variables.begin(), variables.end(), [](const auto& left, const auto& right) {
    return _wcsicmp(left.first.c_str(), right.first.c_str()) < 0;
  });

  std::vector<wchar_t> block;
  for (const auto& [name, value] : variables) {
    const std::wstring entry = name + L"=" + value;
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

bool buildCommandLine(const fs::path& innerExecutable, const fs::path& profile,
                     std::wstring& commandLine, std::wstring& failure) {
  int count = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (arguments == nullptr || count < 1) {
    if (arguments != nullptr) LocalFree(arguments);
    failure = L"Could not read the launcher command line.";
    return false;
  }

  std::vector<std::wstring> forwarded;
  for (int index = 1; index < count; ++index) {
    const std::wstring argument(arguments[index]);
    if (isConflictingSwitch(argument)) {
      LocalFree(arguments);
      failure = L"The launcher does not allow command-line overrides for portable storage or logging.";
      return false;
    }
    forwarded.push_back(argument);
  }
  LocalFree(arguments);

  commandLine = quoteArgument(innerExecutable.native());
  commandLine += L" ";
  commandLine += quoteArgument(L"--user-data-dir=" + profile.native());
  for (const auto& argument : forwarded) {
    commandLine += L" ";
    commandLine += quoteArgument(argument);
  }
  return true;
}

std::wstring modulePath() {
  std::wstring path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size()) {
    throw std::wstring(L"Could not resolve the root launcher path: ") + windowsErrorMessage(GetLastError());
  }
  path.resize(length);
  return path;
}

int launchPortableEditor() {
  const fs::path launcherPath(modulePath());
  const fs::path root = launcherPath.parent_path();
  fs::path innerExecutable;
  fs::path profile;
  fs::path temp;
  fs::path logs;
  fs::path crashes;
  std::wstring failure;
  if (!validateLayout(root, launcherPath, innerExecutable, profile, temp, logs, crashes, failure)) {
    showError(failure);
    return 1;
  }

  std::wstring commandLine;
  if (!buildCommandLine(innerExecutable, profile, commandLine, failure)) {
    showError(failure);
    return 1;
  }
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');
  std::vector<wchar_t> environment = childEnvironment(root, temp);
  if (environment.empty()) {
    showError(L"Could not prepare the portable runtime environment.");
    return 1;
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
        innerExecutable.c_str(),
        mutableCommand.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_UNICODE_ENVIRONMENT,
        environment.data(),
        nullptr,
        &startup,
        &process)) {
    showError(L"The packaged Electron runtime could not be started. Re-extract the complete archive.\n\n"
      + windowsErrorMessage(GetLastError()));
    return 1;
  }

  CloseHandle(process.hThread);
  const DWORD waitResult = WaitForSingleObject(process.hProcess, INFINITE);
  if (waitResult != WAIT_OBJECT_0) {
    const DWORD error = waitResult == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE;
    CloseHandle(process.hProcess);
    showError(L"Waiting for PDF-Scrubber to finish failed: " + windowsErrorMessage(error));
    return 1;
  }

  DWORD exitCode = 1;
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
    const DWORD error = GetLastError();
    CloseHandle(process.hProcess);
    showError(L"Could not read the PDF-Scrubber exit status: " + windowsErrorMessage(error));
    return 1;
  }
  CloseHandle(process.hProcess);
  return static_cast<int>(exitCode);
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    return launchPortableEditor();
  } catch (const std::wstring& failure) {
    showError(failure);
  } catch (...) {
    showError(L"An unexpected error prevented the portable application from starting.");
  }
  return 1;
}
