package com.vdtp.receiver;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Thin native shell around the same receiver page that ships as
 * dist/receiver.html. The decoding is all JavaScript; this class exists to
 * solve the three things a plain web page cannot do on Android.
 */
public class MainActivity extends Activity {

  /**
   * Assets are served under an https:// origin rather than loaded from
   * file:///android_asset. getUserMedia is gated on a secure context, and
   * file:// is not one — the page would load and then be unable to open the
   * camera, which is the whole point of the app. Intercepting requests for
   * this host is what WebViewAssetLoader does; doing it by hand keeps the apk
   * free of androidx.
   */
  private static final String ORIGIN = "https://vdtp.local/";
  private static final String HOST = "vdtp.local";

  private static final int REQ_CAMERA = 1;
  private static final int REQ_SAVE = 2;

  private WebView web;
  private ByteArrayOutputStream pending;   // decoded file waiting for a destination
  private String pendingName = "vdtp-file.bin";
  private String pendingMime = "application/octet-stream";

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    web = new WebView(this);
    web.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);   // otherwise the preview never starts

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        Uri url = req.getUrl();
        if (!HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.equals("/")) path = "/receiver.html";
        try {
          InputStream in = getAssets().open(path.substring(1));
          String mime = path.endsWith(".html") ? "text/html" : "application/octet-stream";
          return new WebResourceResponse(mime, "utf-8", in);
        } catch (IOException e) {
          return null;
        }
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        // The page asked for the camera; the OS-level grant is handled separately.
        runOnUiThread(new Runnable() {
          public void run() { request.grant(request.getResources()); }
        });
      }
    });

    web.addJavascriptInterface(new Bridge(), "VdtpNative");

    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
    }
    web.loadUrl(ORIGIN + "receiver.html");
  }

  @Override
  public void onRequestPermissionsResult(int code, String[] perms, int[] granted) {
    if (code == REQ_CAMERA && (granted.length == 0 || granted[0] != PackageManager.PERMISSION_GRANTED)) {
      Toast.makeText(this, "没有摄像头权限，无法接收", Toast.LENGTH_LONG).show();
    }
  }

  @Override
  public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  /**
   * The page's normal save path is a blob: URL on an <a download>. WebView
   * cannot download blob: URLs, so inside the app the page hands the bytes here
   * instead and the user picks a destination through the storage picker — which
   * also means the app needs no storage permission at all.
   *
   * Chunked because a multi-megabyte base64 string in a single bridge call is
   * a needless allocation spike.
   */
  private class Bridge {
    @JavascriptInterface
    public void saveBegin(String name, String mime) {
      pending = new ByteArrayOutputStream();
      if (name != null && !name.isEmpty()) pendingName = name;
      if (mime != null && !mime.isEmpty()) pendingMime = mime;
    }

    @JavascriptInterface
    public void saveChunk(String base64) {
      if (pending == null) return;
      byte[] part = Base64.decode(base64, Base64.DEFAULT);
      pending.write(part, 0, part.length);
    }

    @JavascriptInterface
    public void saveEnd() {
      if (pending == null) return;
      runOnUiThread(new Runnable() {
        public void run() {
          Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
          i.addCategory(Intent.CATEGORY_OPENABLE);
          i.setType(pendingMime);
          i.putExtra(Intent.EXTRA_TITLE, pendingName);
          startActivityForResult(i, REQ_SAVE);
        }
      });
    }
  }

  @Override
  protected void onActivityResult(int code, int result, Intent data) {
    super.onActivityResult(code, result, data);
    if (code != REQ_SAVE) return;
    if (result != RESULT_OK || data == null || data.getData() == null || pending == null) {
      pending = null;
      return;
    }
    try {
      OutputStream out = getContentResolver().openOutputStream(data.getData());
      out.write(pending.toByteArray());
      out.flush();
      out.close();
      Toast.makeText(this, "已保存 " + pendingName, Toast.LENGTH_LONG).show();
    } catch (IOException e) {
      Toast.makeText(this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
    } finally {
      pending = null;
    }
  }
}
