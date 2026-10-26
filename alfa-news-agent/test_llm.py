from openai import OpenAI


# ==========================================
# 1. CONFIGURATION — настройки модели
# ==========================================

API_KEY = "НАШ КЛЮЧ"
BASE_URL = "https://api.alfahack-gateway26.ru/v1"
MODEL = "deepseek/deepseek-v4.1-flash"


# ==========================================
# 2. CLIENT — подключение к API
# ==========================================

client = OpenAI(
    api_key=API_KEY,
    base_url=BASE_URL,
    timeout=30.0,
    max_retries=0,
)


# ==========================================
# 3. CONNECTION TEST — проверка подключения
# ==========================================

def test_connection():
    """Проверяет, отвечает ли выбранная модель."""

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": "Ответь одним словом: OK",
            }
        ],
        max_tokens=100,
    )

    answer = response.choices[0].message.content

    print("Подключение успешно!")
    print(f"Модель: {MODEL}")
    print(f"Ответ: {answer}")


# ==========================================
# 4. ENTRY POINT — запуск проверки
# ==========================================

if __name__ == "__main__":
    try:
        test_connection()
    except Exception as error:
        print(f"Ошибка подключения: {type(error).__name__}: {error}")
