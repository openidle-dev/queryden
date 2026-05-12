; NSIS installer hooks for QueryDen
; ---------------------------------
; Replaces the default Tauri "please uninstall the previous version first"
; prompt with a one-click silent upgrade. Looks for a registered uninstaller
; in both registry hives (HKCU for per-user installs, HKLM for legacy
; per-machine installs from v1.0.5 / v1.0.6) and runs each with /S.
;
; If both keys exist (mid-transition users), we run the user-scoped one
; first because it doesn't require elevation. The HKLM one will trigger a
; UAC prompt once; from v1.0.7 onward all installs are per-user and future
; upgrades are seamless.

!include LogicLib.nsh

!macro NSIS_HOOK_PREINSTALL
  Var /GLOBAL QDPrevUninstallHKCU
  Var /GLOBAL QDPrevUninstallHKLM

  ClearErrors
  ReadRegStr $QDPrevUninstallHKCU HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\QueryDen" \
    "UninstallString"
  ${If} ${Errors}
    StrCpy $QDPrevUninstallHKCU ""
  ${EndIf}

  ClearErrors
  ReadRegStr $QDPrevUninstallHKLM HKLM \
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\QueryDen" \
    "UninstallString"
  ${If} ${Errors}
    StrCpy $QDPrevUninstallHKLM ""
  ${EndIf}

  ${If} $QDPrevUninstallHKCU != ""
    DetailPrint "Removing previous QueryDen install (user-scoped)..."
    ; UninstallString already includes the quoted path; /S = silent.
    ExecWait '$QDPrevUninstallHKCU /S'
  ${EndIf}

  ${If} $QDPrevUninstallHKLM != ""
    DetailPrint "Removing previous QueryDen install (machine-wide)..."
    ExecWait '$QDPrevUninstallHKLM /S'
  ${EndIf}
!macroend
