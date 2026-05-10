@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Starting AutoEnthra website preview on http://localhost:7870
echo.
start "" http://localhost:7870
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 7870
) else (
  where node >nul 2>nul
  if %errorlevel%==0 (
    node -e "const http=require('http'),fs=require('fs'),path=require('path');const mt={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};http.createServer((req,res)=>{let p=path.join(__dirname,req.url==='/'?'index.html':req.url.split('?')[0]);fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);return res.end('404')}res.writeHead(200,{'Content-Type':mt[path.extname(p)]||'application/octet-stream'});res.end(d)})}).listen(7870,()=>console.log('listening on 7870'));"
  ) else (
    echo  [!] Need Python or Node.js installed to run a local preview server.
    echo      Or just open index.html directly in your browser.
    pause
  )
)
