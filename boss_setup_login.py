"""
Boss 一次性扫码登录 + 养指纹脚本

跑一次,扫码登录,浏览几分钟养指纹,user_data 就有真实登录态了。
之后 boss_drission.py 直接用,不用每次都扫码。

运行:
  cd D:\\BOOSPQ
  .venv\\Scripts\\python.exe boss_setup_login.py

session 大约 2-4 周失效,失效后重跑此脚本即可。
"""

import shutil
import time
from pathlib import Path

from DrissionPage import ChromiumPage, ChromiumOptions
from DrissionPage.common import Settings

Settings.set_language('zh_cn')

PROJECT_DIR = Path(r'D:\BOOSPQ')
CHROME_PATH = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
LOCAL_PORT  = 60003
USER_DATA   = PROJECT_DIR / 'drission_user_data'


def main():
    print('=' * 60)
    print('Boss 登录态设置 · 一次性扫码 + 养指纹')
    print('=' * 60)
    print(f'user_data 目录: {USER_DATA}')
    print()

    # 检查 user_data 是否已存在
    if USER_DATA.exists() and any(USER_DATA.iterdir()):
        print(f'⚠ user_data 已存在(里面可能有上次的失败状态)')
        print('  [r] 复用现有(只补登录,保留浏览历史)')
        print('  [c] 清空重来(推荐,彻底干净)')
        print('  [q] 退出')
        choice = input('  选择 [r/c/q]: ').strip().lower()
        if choice == 'c':
            print('  清空旧 user_data...')
            shutil.rmtree(USER_DATA, ignore_errors=True)
            time.sleep(0.5)
            USER_DATA.mkdir(parents=True, exist_ok=True)
        elif choice == 'q':
            print('已退出')
            return
        # 'r' 或其他: 复用现有
    else:
        USER_DATA.mkdir(parents=True, exist_ok=True)

    print()
    print('即将启动 Chrome,请按以下步骤操作:')
    print('  1. 弹出的 Chrome 里手动登录 zhipin.com (手机扫码 / 短信验证码)')
    print('  2. 登录后【重点】:')
    print('     · 点几个职位卡进详情看看')
    print('     · 滚动几下列表')
    print('     · 切换 1-2 次筛选条件')
    print('     · 总共浏览 5-10 分钟')
    print('  3. ★ 不养指纹直接退出 → 下次 boss_drission.py 大概率触发 security_check')
    print('  4. 浏览完回到本终端按回车保存')
    print()
    input('准备好按回车启动 Chrome ...')

    co = (ChromiumOptions()
          .set_browser_path(CHROME_PATH)
          .set_local_port(LOCAL_PORT)
          .set_user_data_path(str(USER_DATA)))
    co.set_argument('--no-default-browser-check')
    co.set_argument('--no-first-run')
    co.set_argument('--disable-infobars')
    co.set_argument('--disable-popup-blocking')
    co.set_argument('--hide-crash-restore-bubble')

    dp = ChromiumPage(co)
    dp.get('https://www.zhipin.com/')

    print()
    print('✓ Chrome 已启动,请去那个窗口操作')
    print('  (不要关掉那个窗口,操作完回这里按回车)')
    print()

    input('★ 登录 + 浏览 5-10 分钟后,按回车保存退出 ...')

    # 验证登录态(DrissionPage 4.x 改了 cookies API,用兼容写法)
    cookies = {}
    try:
        raw = dp.cookies()
        # 兼容多种返回结构: CookieList / list / 含 as_dict 方法
        if hasattr(raw, 'as_dict'):
            try:
                cookies = raw.as_dict()
            except Exception:
                pass
        if not cookies:
            for c in raw:
                if isinstance(c, dict):
                    cookies[c.get('name', '')] = c.get('value', '')
                else:
                    try:
                        cookies[c['name']] = c['value']
                    except Exception:
                        pass
    except Exception as e:
        print(f'⚠ 读取 cookies 失败: {e}')

    has_wt2 = 'wt2' in cookies
    has_at  = 'zp_at' in cookies
    has_bst = 'bst' in cookies
    has_a   = '__a' in cookies

    print()
    print(f'当前 URL: {dp.url}')
    print(f'  wt2:        {"✓" if has_wt2 else "✗ 缺失"}')
    print(f'  zp_at:      {"✓" if has_at else "✗ 缺失"}')
    print(f'  bst:        {"✓" if has_bst else "✗ 缺失"}')
    if has_a:
        uid = cookies['__a'].split('.')[0]
        print(f'  __a (uid):  ✓ uid={uid}')
    else:
        print(f'  __a (uid):  ✗ 缺失')
    print()

    if has_wt2 and has_at and has_bst:
        print('✓ 登录态已保存到 user_data')
        print('  接下来运行: .venv\\Scripts\\python.exe boss_drission.py')
    else:
        print('⚠ 关键 cookie 缺失,可能没真正登录成功')
        print('  建议: 重新跑此脚本,选 [c] 清空重来')

    print()
    input('按回车关闭浏览器 ...')
    try:
        dp.quit()
    except Exception:
        pass


if __name__ == '__main__':
    main()
