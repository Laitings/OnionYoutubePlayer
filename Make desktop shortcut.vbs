Option Explicit
' Puts an "Onion Player" shortcut with the onion icon on your desktop.
Dim sh, fso, dir, lnk
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Onion Player.lnk")
lnk.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
lnk.Arguments = """" & dir & "\Onion Player.vbs"""
lnk.WorkingDirectory = dir
lnk.IconLocation = dir & "\onion.ico"
lnk.Description = "Onion Player"
lnk.Save
MsgBox "Done. There is now an Onion Player shortcut on your desktop." & vbCrLf & vbCrLf & "Tip: right-click it and choose Pin to taskbar or Pin to Start.", 64, "Onion Player"
