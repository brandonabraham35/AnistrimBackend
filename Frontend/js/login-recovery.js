/**
 * login-recovery.js - Mobile Login Recovery Layer
 *
 * Handles: navigation failures, cold starts, app resume mid-auth,
 * stale auth attempts, double-tap, loop protection, onboarding.
 *
 * Exports: window.LoginRecovery
 */

(function(root){
  "use strict";
  var T=6e4,N=2e3,R="_lrBudget",M=1,X=6e5;
  var ri="_loginRedirect",pi="_authPending";
  var ai="_lrAuthInProgress",ni="_lrNavigatedAway",nri="_lrNoRecover";
  var rb=null,at=null,nw=null,re=true;

  function l(m){var a=root.__GoogleAuth;if(a&&typeof a.log==="function"){a.log("[LR] "+m);}else{try{console.log("[LoginRecovery] "+m);}catch(e){}}}
  function w(m){try{console.warn("[LoginRecovery] "+m);}catch(e){}}
  function e(m){var a=root.__GoogleAuth;if(a&&typeof a.err==="function"){a.err("[LR] "+m);}else{try{console.error("[LoginRecovery] "+m);}catch(e){}}}
  function cp(){return(root.location.pathname||"").split("/").pop()||"index.html";}
  function go(d){d=String(d);if(root.NavGuard&&typeof root.NavGuard.go==="function"){return root.NavGuard.go(d);}root.location.replace(d);return true;}
  function se(m){if(typeof root.showError==="function"){root.showError(m);return;}var el=document.getElementById("auth-error");if(!el){el=document.createElement("p");el.id="auth-error";el.style.cssText="color:#f87171;font-size:0.85rem;text-align:center;margin-bottom:10px;";var btn=document.getElementById("google-login-btn")||document.getElementById("google-signup-btn");if(btn&&btn.parentNode){btn.parentNode.insertBefore(el,btn.nextSibling);}else{var s2=document.querySelector(".auth-submit");if(s2&&s2.parentNode){s2.parentNode.insertBefore(el,s2);}}}el.style.display="block";el.textContent=m;}
  function rgb(){if(typeof root.setGoogleBtnReady==="function"){root.setGoogleBtnReady();return;}var b=document.getElementById("google-login-btn")||document.getElementById("google-signup-btn");var l2=document.getElementById("google-btn-text");if(b){b.disabled=false;}if(l2){l2.textContent="Continue with Google";}}
  function lb(){if(rb!==null){return;}try{var ra=sessionStorage.getItem(R);if(ra){var p2=JSON.parse(ra);if(p2.expires&&p2.expires>Date.now()){rb=p2.budget;return;}}}catch(e){}rb=M;}
  function sb(){try{sessionStorage.setItem(R,JSON.stringify({budget:rb,expires:Date.now()+X}));}catch(e){}}
  function rsb(){rb=M;sb();try{sessionStorage.removeItem(nri);}catch(e){}}
  function grp(){try{var fu=new URLSearchParams(root.location.search).get("redirect");if(fu){sessionStorage.setItem(ri,fu);return fu;}return sessionStorage.getItem(ri)||"";}catch(e){return "";}}
  function cpa(){try{sessionStorage.removeItem(pi);}catch(e){}try{sessionStorage.removeItem(ai);}catch(e){}try{sessionStorage.removeItem(ni);}catch(e){}if(at){clearTimeout(at);at=null;}if(nw){clearTimeout(nw);nw=null;}}
  function br(dest,reason){
    if(!re){l("Disabled: "+reason);return false;}
    if(cp()===dest.split("?")[0].split("/").pop()){l("Already on "+dest);return false;}
    try{if(sessionStorage.getItem(nri)==="1"){se("Sign-in succeeded but navigation interrupted.");return false;}}catch(e){}
    lb();if(rb<=0){se("Unable to complete sign-in. Please restart.");return false;}
    rb--;sb();
    try{sessionStorage.setItem(nri,"1");}catch(e){}
    try{sessionStorage.setItem("__authRedirecting","1");}catch(e){}
    go(dest);return true;
  }

  function cs(){
    var s2=null;
    if(root.AniStrimSession&&typeof root.AniStrimSession.create==="function"){s2=root.AniStrimSession.create("mobile");}
    var tk="";if(s2){tk=s2.getToken()||"";}if(!tk){try{tk=localStorage.getItem("token")||localStorage.getItem("session_token")||"";}catch(e){}}
    if(!tk){return{valid:false,token:null,user:null};}
    if(root.Auth&&typeof root.Auth.isExpired==="function"&&root.Auth.isExpired()){if(root.Auth&&typeof root.Auth.clear==="function"){root.Auth.clear();}return{valid:false,token:null,user:null};}
    var us=null;if(root.Auth&&root.Auth.user){us=root.Auth.user;}if(!us){try{us=JSON.parse(localStorage.getItem("user")||"null");}catch(e){}}
    var iv=true;if(root.Auth&&typeof root.Auth.isLoggedIn!=="undefined"){iv=!!root.Auth.isLoggedIn;}
    return{valid:iv&&!!tk,token:tk,user:us};
  }

  function vws(token){
    return new Promise(function(resolve){
      if(!token){resolve(null);return;}
      var ab=(typeof root.getApiBaseUrl==="function")?root.getApiBaseUrl():"https://anistrimbackend.onrender.com";
      var ctrl=new AbortController();var tid=setTimeout(function(){ctrl.abort();},10000);
      fetch(ab+"/api/auth/me",{method:"GET",headers:{"Authorization":"Bearer "+token,"Accept":"application/json"},signal:ctrl.signal})
      .then(function(res){
        clearTimeout(tid);
        if(res.status===401){if(root.Auth&&typeof root.Auth.clear==="function"){root.Auth.clear();}resolve(null);return;}
        return res.json().then(function(data){
          if(data&&data.id){
            if(root.Auth&&typeof root.Auth.setUser==="function"){root.Auth.setUser(data);}
            if(root.Session&&typeof root.Session.setUser==="function"){root.Session.setUser(data);}
            resolve(data);
          }else{var ca=null;try{ca=JSON.parse(localStorage.getItem("user")||"null");}catch(e){}resolve(ca||null);}
        });
      }).catch(function(){clearTimeout(tid);var ca=null;try{ca=JSON.parse(localStorage.getItem("user")||"null");}catch(e){}resolve(ca||null);});
    });
  }

  function csoi(){
    try{if(sessionStorage.getItem(ni)==="1"){return;}}catch(e){}
    var info=cs();if(!info.valid||!info.token){return;}
    vws(info.token).then(function(user){var rp=grp();try{sessionStorage.setItem(ni,"1");}catch(e){}br(rd(user,rp),"session-found");});
  }

  function naa(user,token,refreshToken){
    var s2=null;
    if(root.AniStrimSession&&typeof root.AniStrimSession.create==="function"){s2=root.AniStrimSession.create("mobile");}
    if(s2){s2.setTokens(token,refreshToken);}else{try{localStorage.setItem("token",token);if(refreshToken){localStorage.setItem("refresh_token",refreshToken);}}catch(e){}}
    if(root.Auth){root.Auth.save(token,user,refreshToken);}else{try{localStorage.setItem("user",JSON.stringify(user));}catch(e){}}
    var rb2=cs();if(!rb2.valid||!rb2.token){se("Session verification failed.");rgb();cpa();return false;}
    try{sessionStorage.setItem(ni,"1");}catch(e){}
    vws(rb2.token).then(function(su){if(su){user=su;}var dest=rd(user,grp());rsb();try{sessionStorage.setItem("__authRedirecting","1");}catch(e){}go(dest);snw(user,rb2.token);});
    return true;
  }

  function snw(user,token){
    if(nw){clearTimeout(nw);}
    nw=setTimeout(function(){
      nw=null;
      if(cp()!=="login.html"){return;}
      var info=cs();
      if(info.valid&&info.token){
        vws(info.token).then(function(fu){try{sessionStorage.setItem("__authRedirecting","1");}catch(e){}br(rd(fu||user,grp()),"nav-failure");});
      }else{se("Sign-in was interrupted. Please try again.");rgb();cpa();}
    },N);
  }

  function har(state){
    if(!state||!state.isActive){return;}
    var ap=false;try{ap=sessionStorage.getItem(ai)==="1";}catch(e){}
    if(ap){if(at){clearTimeout(at);at=setTimeout(hsat,T);}}
    else{var info=cs();if(info.valid&&info.token&&cp()==="login.html"){vws(info.token).then(function(user){try{sessionStorage.setItem(ni,"1");}catch(e){}try{sessionStorage.setItem("__authRedirecting","1");}catch(e){}br(rd(user,grp()),"resume");});}}
  }

  function hsat(){at=null;var wp=false;try{wp=sessionStorage.getItem(pi)==="1";}catch(e){}try{wp=wp||sessionStorage.getItem(ai)==="1";}catch(e){}cpa();rgb();if(wp){se("Google sign-in timed out. Please try again.");}}

  function taal(){var lk=false;try{lk=sessionStorage.getItem(ai)==="1";}catch(e){}if(lk){se("Sign-in already in progress.");return false;}try{sessionStorage.setItem(ai,"1");}catch(e){}try{sessionStorage.setItem(pi,"1");}catch(e){}if(at){clearTimeout(at);}at=setTimeout(hsat,T);return true;}
  function ral(){cpa();}

  function rd(user,rp){
    if(!user){return rp||"index.html";}
    if(user.status&&user.status!=="active"){return "account-status.html?status="+encodeURIComponent(user.status);}
    if(!user.emailVerified){return "verify-otp.html";}
    if(!user.onboarded){return "onboarding.html";}
    if(user.isAdmin&&!rp){return "admin.html";}
    return rp||"index.html";
  }

  var LR={
    init:function(){lb();try{sessionStorage.removeItem(ni);}catch(e){}csoi();this.ral();this.csa();},
    ral:function(){var CA=null;try{CA=root.Capacitor&&root.Capacitor.Plugins&&root.Capacitor.Plugins.App;}catch(e){}if(CA&&typeof CA.addListener==="function"){try{CA.removeListener("appStateChange",har);}catch(e){}CA.addListener("appStateChange",har);}},
    was:function(){if(typeof root.setGoogleBtnLoading==="function"){root.setGoogleBtnLoading("Signing in...");}return taal();},
    dfa:function(){ral();rgb();},
    oas:function(u,t,rt){naa(u,t,rt);return true;},
    oaf:function(m){ral();se(m||"Sign-in failed.");rgb();},
    oac:function(){ral();rgb();},
    csa:function(){var hp=false;try{hp=sessionStorage.getItem(pi)==="1";}catch(e){}if(hp){var info=cs();if(info.valid&&info.token){vws(info.token).then(function(user){try{sessionStorage.setItem(ni,"1");}catch(e){}try{sessionStorage.setItem("__authRedirecting","1");}catch(e){}br(rd(user,grp()),"stale");});return;}cpa();rgb();se("Previous sign-in was interrupted. Please try again.");}},
    snw:function(u,t){snw(u,t);},
    sre:function(en){re=!!en;},
    gs:function(){var hl=false,nr=false;try{hl=sessionStorage.getItem(ai)==="1";}catch(e){}try{nr=sessionStorage.getItem(nri)==="1";}catch(e){}return{br:rb,re:re,pg:cp(),sv:cs().valid,ahl:hl,anr:nr};}
  };

  root.LoginRecovery=LR;
})(typeof window!=="undefined"?window:this);
