require('http').createServer((q,s)=>s.end('hello v2 '+(process.env.GREETING||''))).listen(process.env.PORT,()=>console.log('listening on',process.env.PORT));
