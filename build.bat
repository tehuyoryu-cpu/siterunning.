@echo off
echo [1/3] npm install...
call npm install
if errorlevel 1 goto error

echo [2/3] pkg install...
call npm install -g pkg
if errorlevel 1 goto error

echo [3/3] building exe...
call pkg . --target node18-win-x64 --output dist\dlsite-tracker.exe
if errorlevel 1 goto error

echo.
echo Build OK: dist\dlsite-tracker.exe
goto end

:error
echo Build FAILED
exit /b 1

:end
