@echo off
title VALEVENTAS by VT VALETEC - Iniciador Local
color 0A
cls

echo ============================================================
echo      VALEVENTAS by VT VALETEC - Sistema POS & Fiados
echo ============================================================
echo.
echo  Iniciando los contenedores de PostgreSQL, Backend y Frontend...
echo.

docker compose up -d

if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] No se pudo iniciar Docker Desktop. 
    echo  Asegurate de que Docker Desktop este abierto y ejecutandose.
    echo.
    pause
    exit /b %errorlevel%
)

echo.
echo ============================================================
echo  [EXITO] El sistema se ha iniciado correctamente.
echo  Abriendo el Punto de Venta en tu navegador web...
echo  Direccion: http://localhost:3000
echo ============================================================
echo.

timeout /t 3 >nul
start http://localhost:3000
exit
