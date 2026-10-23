package com.zynora.trendyipo;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

/** Trendy IPO: the website in a full-screen WebView (no browser bar). Only https://noor1204.github.io/IPO/ is shown inside the app, every other link opens in the phone's browser. */
public class MainActivity extends Activity {
    private static final String HOST = "noor1204.github.io";
    private static final String HOME = "https://noor1204.github.io/IPO/";
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.parseColor("#eceefb"));
        getWindow().setNavigationBarColor(Color.parseColor("#eceefb"));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#eceefb"));
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(false);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client(this));
        web.setDownloadListener((url, ua, cd, mime, len) -> openOutside(Uri.parse(url)));

        if (b != null) web.restoreState(b); else web.loadUrl(HOME);
    }

    void openOutside(Uri u) {
        String sc = u.getScheme();
        if (!"https".equals(sc) && !"mailto".equals(sc) && !"tel".equals(sc)) return;   // never hand other schemes (intent:, file:, javascript:) to the phone
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show(); }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
}
