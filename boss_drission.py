"""
Boss 直聘采集 - DrissionPage 双重监听版(上海大数据/AI 专版)

基于 C:\\Users\\Administrator\\Desktop\\code\\doublelisten copy 3.py 改造。

★ 重要: 第一次跑之前,必须先跑 boss_setup_login.py 手动扫码登录 + 浏览
   5-10 分钟养指纹。直接灌 cookie 会被 Boss 识破触发 security_check。

依赖:
  pip install DrissionPage

运行流程:
  cd D:\\BOOSPQ
  .venv\\Scripts\\python.exe boss_setup_login.py    # 一次性扫码,2-4 周一次
  .venv\\Scripts\\python.exe boss_drission.py        # 之后随时跑

输出:
  D:\\BOOSPQ\\data\\job_list\\YYYYMMDD\\position_{code}.csv     列表数据
  D:\\BOOSPQ\\data\\job_detail\\YYYYMMDD\\position_{code}.csv   详情数据
"""

import os
import json
import csv
import time
import random
import traceback
from pathlib import Path

from DrissionPage import ChromiumPage, ChromiumOptions
from DrissionPage.errors import ElementNotFoundError, WaitTimeoutError
from DrissionPage.common import Settings

Settings.set_language('zh_cn')

# ============================================================
# ★ 配置区(改这里)
# ============================================================
PROJECT_DIR = Path(r'D:\BOOSPQ')
COOKIE_FILE = PROJECT_DIR / 'cookies_account1.json'

CHROME_PATH = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
LOCAL_PORT  = 60003
USER_DATA   = PROJECT_DIR / 'drission_user_data'   # 首次运行会自动创建

# 输出目录(按天分目录)
TODAY = time.strftime("%Y%m%d")
SAVE_DIR_LIST   = PROJECT_DIR / 'data' / 'job_list'   / TODAY
SAVE_DIR_DETAIL = PROJECT_DIR / 'data' / 'job_detail' / TODAY

# 14 个大数据/AI 相关职位(可加减)
POSITION_CODES = [
    100508,  # 数据开发
    100506,  # ETL工程师
    100507,  # 数据仓库
    100512,  # 数据架构师
    100515,  # 数据治理
    100511,  # 数据分析师
    100104,  # 数据挖掘
    100122,  # 数据采集
    100120,  # 算法工程师
    101301,  # 机器学习
    101310,  # 大模型算法
    100117,  # NLP算法
    100118,  # 推荐算法
    100115,  # 搜索算法
]

# URL 筛选参数(逗号多值,Boss 原生支持)
URL_PARAMS = {
    'city':       '101020100',         # 上海
    'experience': '104,105',           # 1-3年 / 3-5年
    'scale':      '301,302,303',       # 0-20人 / 20-99人 / 100-499人
    'salary':     '405,406',           # 10-20K / 20-50K
}
SORT_TYPE = '1'   # 1=最新发布;留空=综合排序

# 每个职位最多翻多少页(Boss 实际最多 ~20 页 = 300 条)
MAX_PAGES_PER_POSITION = 20

# 是否抓取详情(False = 只抓列表,快很多)
ENABLE_DETAIL = True


# ============================================================
# 工具函数
# ============================================================
def load_cookies(path: Path) -> list:
    """加载 cookies_account1.json,转成 DrissionPage 格式"""
    if not path.exists():
        raise FileNotFoundError(f'cookie 文件不存在: {path}')
    raw = json.loads(path.read_text(encoding='utf-8'))
    result = []
    for c in raw:
        item = {
            'name':   c['name'],
            'value':  c['value'],
            'domain': c.get('domain', '.zhipin.com'),
            'path':   c.get('path', '/'),
        }
        exp = c.get('expires') or c.get('expirationDate')
        if exp and isinstance(exp, (int, float)) and exp > 0:
            item['expiry'] = int(exp)
        if c.get('secure'):
            item['secure'] = True
        if c.get('httpOnly'):
            item['httpOnly'] = True
        result.append(item)
    return result


def save_to_csv(data_input, position_code, save_dir: Path, prefix: str):
    """保存到 CSV,文件名 {prefix}_{position_code}.csv"""
    if not data_input:
        print('    ! 没有数据需要保存')
        return

    if isinstance(data_input, dict):
        data_list = [data_input]
    elif isinstance(data_input, list):
        data_list = data_input
    else:
        print(f'    ! 数据类型错误: {type(data_input)}')
        return

    if not data_list:
        return

    # 给每行追加 position_code 字段
    for item in data_list:
        if isinstance(item, dict):
            item['position_code'] = position_code

    save_dir.mkdir(parents=True, exist_ok=True)
    filename = save_dir / f'{prefix}_{position_code}.csv'

    if not isinstance(data_list[0], dict):
        print(f'    ! 第一个元素不是字典,无法保存')
        return
    fieldnames = list(data_list[0].keys())

    try:
        with open(filename, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(data_list)
        print(f'    ✓ 已保存 {len(data_list)} 条 → {filename.name}')
    except Exception as e:
        print(f'    ! 保存 CSV 失败: {e}')


def build_url(position_code: int) -> str:
    """拼搜索 URL"""
    params = dict(URL_PARAMS)
    params['position'] = str(position_code)
    qs = '&'.join(f'{k}={v}' for k, v in params.items())
    url = f'https://www.zhipin.com/web/geek/job?{qs}'
    if SORT_TYPE:
        url += f'&sortType={SORT_TYPE}'
    return url


# ============================================================
# 主流程
# ============================================================
def main():
    print('=' * 60)
    print('Boss 采集 · DrissionPage 双重监听版')
    print('上海 · 大数据/AI 14 职位 · 0-499人 · 1-5年 · 10-50K')
    print('=' * 60)

    # 1. 检查 user_data 是否已经手动登录过
    # 新版 Chrome 把 Cookies 放在 Default/Network/Cookies,老版在 Default/Cookies
    candidate_paths = [
        USER_DATA / 'Default' / 'Network' / 'Cookies',
        USER_DATA / 'Default' / 'Cookies',
    ]
    cookies_db = next((p for p in candidate_paths if p.exists()), None)
    if cookies_db is None:
        print('✗ user_data 还没初始化,请先跑:')
        print('    .venv\\Scripts\\python.exe boss_setup_login.py')
        return
    print(f'✓ user_data 已存在: {USER_DATA}')
    print(f'  Cookies DB: {cookies_db.relative_to(USER_DATA)}')

    # 2. 准备目录
    SAVE_DIR_LIST.mkdir(parents=True, exist_ok=True)
    SAVE_DIR_DETAIL.mkdir(parents=True, exist_ok=True)
    print(f'✓ 输出目录就绪')

    # 3. 启动浏览器(用已养好的 user_data,不再灌 cookie)
    print(f'\n启动 Chrome (port={LOCAL_PORT}, user_data={USER_DATA.name})...')
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

    # 4. 验证登录态(检测 /login /passport /web/geek/jobs?_security_check)
    test_url = 'https://www.zhipin.com/web/geek/job?city=101020100'
    dp.get(test_url)
    time.sleep(random.uniform(2, 4))
    cur_url = dp.url
    if '/login' in cur_url or '/passport' in cur_url:
        print(f'✗ 登录态失效(跳转到登录页): {cur_url[:100]}')
        print('  请重新跑 boss_setup_login.py')
        dp.quit()
        return
    if '_security_check' in cur_url:
        print(f'✗ 触发了安全验证: {cur_url[:100]}')
        print('  user_data 指纹不够"真",需要重跑 boss_setup_login.py')
        print('  这次扫码后务必浏览 5-10 分钟以上(多点几个职位、滚几次列表)')
        dp.quit()
        return
    print(f'✓ 登录态有效,当前 URL: {cur_url[:100]}')
    # /web/geek/jobs (复数)是正常重定向,/web/geek/job 也行,只要不带 _security_check 就 OK

    # 6. 主循环
    total_list_count = 0
    total_detail_count = 0

    for pi, position_code in enumerate(POSITION_CODES, 1):
        print(f'\n--- [{pi}/{len(POSITION_CODES)}] 职位代码: {position_code} ---')
        position_data_info = []
        current_position_details = []

        # 开第一阶段监听 - 列表
        dp.listen.start('wapi/zpgeek/search/joblist.json')
        try:
            list_url = build_url(position_code)
            print(f'  访问: {list_url[:120]}')
            dp.get(list_url)
            time.sleep(random.uniform(2, 5))

            for page in range(1, MAX_PAGES_PER_POSITION + 1):
                print(f'  · 第 {page} 页')
                dp.scroll.to_bottom()
                try:
                    resp1 = dp.listen.wait(timeout=15)
                except TimeoutError:
                    print(f'    ! 等响应超时,本职位结束')
                    break

                try:
                    json_data = resp1.response.body
                    if not isinstance(json_data, dict):
                        print(f'    ! 响应不是字典: {type(json_data)}')
                        break

                    code = json_data.get('code')
                    if code != 0:
                        print(f'    ! API 错误 code={code} msg={json_data.get("message")}')
                        if code == 37:
                            sleep_dur = random.uniform(60, 120)
                            print(f'    ⏸ 行为异常 (code=37),冷却 {sleep_dur:.0f}s')
                            time.sleep(sleep_dur)
                        break

                    job_list = json_data.get('zpData', {}).get('jobList', [])
                    if not job_list:
                        has_more = json_data.get('zpData', {}).get('hasMore', False)
                        if not has_more:
                            print(f'    ✓ 已无更多数据 (jobList 空 + hasMore=false)')
                            break
                        print(f'    · 本页空,但 hasMore=true,继续')
                        time.sleep(random.uniform(1, 3))
                        continue

                    position_data_info.extend(job_list)
                    print(f'    + 累计 {len(position_data_info)} 条')

                    has_more = json_data.get('zpData', {}).get('hasMore', False)
                    if not has_more:
                        print(f'    ✓ 已无更多数据 (hasMore=false)')
                        break

                    time.sleep(random.uniform(1, 6))
                except Exception as e:
                    print(f'    ! 处理响应出错: {e}')
                    traceback.print_exc()
                    break

            # 保存列表
            if position_data_info:
                save_to_csv(position_data_info, position_code, SAVE_DIR_LIST, 'position')
                total_list_count += len(position_data_info)
            else:
                print(f'  ! 列表无数据')

            ts = time.strftime("%H:%M:%S", time.localtime())
            print(f'  ✓ {ts} 职位 {position_code} 列表完毕')

            # ============================================
            # Phase 2: 详情
            # ============================================
            if ENABLE_DETAIL and position_data_info:
                dp.listen.pause()
                dp.listen.start('wapi/zpgeek/job/detail.json')

                processed_job_links = set()
                job_card_selector = 'xpath://div[contains(@class, "card-area")]'
                job_cards = dp.eles(job_card_selector)

                if not job_cards:
                    print(f'  ! 未找到职位卡片,跳过详情')
                else:
                    print(f'  · 找到 {len(job_cards)} 个职位卡,开始抓详情')
                    job_cards.reverse()  # 倒序点击,避免漏新卡

                    for i, card in enumerate(job_cards):
                        try:
                            job_link_el = card.ele('.job-card-box')
                            job_link = job_link_el.attr('href') if job_link_el else None
                            if job_link:
                                full_link = f'https://www.zhipin.com{job_link}'
                                if full_link in processed_job_links:
                                    continue
                                processed_job_links.add(full_link)

                            print(f'    · [{i+1}/{len(job_cards)}] 点击职位卡')
                            card.click()

                            try:
                                resp = dp.listen.wait(timeout=20)
                                json_data = resp.response.body

                                if not isinstance(json_data, dict):
                                    print(f'      ! detail 非字典: {type(json_data)}')
                                    continue
                                code = json_data.get('code')
                                if code != 0:
                                    print(f'      ! detail API 错误 code={code}')
                                    if code == 37:
                                        sleep_dur = random.uniform(60, 120)
                                        print(f'      ⏸ 行为异常,冷却 {sleep_dur:.0f}s')
                                        time.sleep(sleep_dur)
                                    continue
                                job_info = json_data.get('zpData', {}).get('jobInfo', {})
                                if job_info:
                                    current_position_details.append(job_info)
                            except WaitTimeoutError:
                                print(f'      ! 等 detail 超时')
                            except Exception as ew:
                                print(f'      ! detail 处理出错: {ew}')

                            time.sleep(random.uniform(1, 5))
                        except ElementNotFoundError as ec:
                            print(f'    ! 卡片元素未找到: {ec}')
                        except Exception as ei:
                            print(f'    ! 卡片处理异常: {ei}')

                # 保存详情
                if current_position_details:
                    save_to_csv(current_position_details, position_code, SAVE_DIR_DETAIL, 'position')
                    total_detail_count += len(current_position_details)
                else:
                    print(f'  ! 详情无数据')

            ts = time.strftime("%H:%M:%S", time.localtime())
            sleep_time = random.uniform(6, 20)
            print(f'  ✓ {ts} 职位 {position_code} 完毕,冷却 {sleep_time:.0f}s')
            time.sleep(sleep_time)

        except Exception as e_outer:
            print(f'  ! 职位 {position_code} 顶层异常: {e_outer}')
            traceback.print_exc()
            time.sleep(random.uniform(5, 15))

    print()
    print('=' * 60)
    print(f'全部完成 · 列表共 {total_list_count} 条 · 详情共 {total_detail_count} 条')
    print(f'列表 → {SAVE_DIR_LIST}')
    print(f'详情 → {SAVE_DIR_DETAIL}')
    print('=' * 60)
    dp.quit()


if __name__ == '__main__':
    main()
