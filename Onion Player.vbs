Option Explicit
' Starts Onion Player without a console window and opens it in its own app window (no address bar or tabs).
' The server stops by itself a few minutes after you close that window.

Dim sh, fso, dir, py, url, port, i, tries, browser, candidates

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

port = sh.ExpandEnvironmentStrings("%ONION_PORT%")
If port = "%ONION_PORT%" Or port = "" Then port = "8765"
url = "http://127.0.0.1:" & port

Function Up()
  Dim h
  Up = False
  On Error Resume Next
  Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
  h.SetTimeouts 500, 500, 500, 500
  h.Open "GET", url & "/api/status", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then Up = True
  End If
  On Error GoTo 0
End Function

If Not Up() Then
  py = dir & "\.venv\Scripts\python.exe"
  If Not fso.FileExists(py) Then
    MsgBox "Onion Player has not been set up yet." & vbCrLf & vbCrLf & "Double-click run.bat once and let it finish starting, close it, then open this again.", 48, "Onion Player"
    WScript.Quit
  End If
  With sh.Environment("Process")
    .Item("ONION_NO_BROWSER") = "1"
    .Item("ONION_AUTOQUIT") = "1"
    .Item("PYTHONUNBUFFERED") = "1"
  End With
  ' A hidden console window (style 0): nothing to see, and the helper programs it starts stay hidden too.
  ' Everything the server prints goes to onion.log.
  sh.Run "cmd /c """"" & py & """ """ & dir & "\app.py"" >> """ & dir & "\onion.log"" 2>&1""", 0, False
  tries = 0
  Do While Not Up() And tries < 80
    WScript.Sleep 500
    tries = tries + 1
  Loop
  If Not Up() Then
    MsgBox "Onion Player did not start. Look at onion.log in the Onion folder, or run run.bat to see what it says.", 48, "Onion Player"
    WScript.Quit
  End If
End If

' Edge is on every Windows 10/11 PC. Chrome is the fallback.
browser = ""
candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe")
For i = 0 To UBound(candidates)
  If fso.FileExists(candidates(i)) Then
    browser = candidates(i)
    Exit For
  End If
Next

If browser = "" Then
  sh.Run url, 1, False
Else
  sh.Run """" & browser & """ --app=" & url & " --window-size=1280,820", 1, False
End If
