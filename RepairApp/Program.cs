using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

var root = H.FindRoot();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    ContentRootPath = root,
    WebRootPath = Path.Combine(root, "wwwroot"),
    Args = args
});
builder.WebHost.UseUrls("http://0.0.0.0:5081");
var app = builder.Build();

Db.DbFile = Path.Combine(root, "repair.db");
H.UploadDir = Path.Combine(root, "wwwroot", "uploads");
Directory.CreateDirectory(H.UploadDir);
Db.Init();

app.UseDefaultFiles();
app.UseStaticFiles();

// функция для ошибок
IResult Err(string message, int code = 400)
{
    return Results.Json(new { error = message }, statusCode: code);
}

// проверка токена
Dictionary<string, object?>? Auth(HttpRequest r)
{
    var authHeader = r.Headers["Authorization"].ToString();
    if (!authHeader.StartsWith("Bearer "))
    {
        return null;
    }

    string token = authHeader.Substring(7);
    var usersList = Db.Q("SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = @token", new { token });

    if (usersList.Count == 0)
    {
        return null;
    }
    return usersList[0];
}

// проверка роли
IResult WithRole(HttpRequest r, string[] roles, Func<Dictionary<string, object?>, IResult> act)
{
    var user = Auth(r);
    if (user == null)
    {
        return Err("Требуется вход в систему", 401);
    }

    string userRole = user.Str("role");
    if (roles.Length > 0)
    {
        bool hasRole = false;
        foreach (var role in roles)
        {
            if (role == userRole)
            {
                hasRole = true;
                break;
            }
        }
        if (!hasRole)
        {
            return Err("Недостаточно прав", 403);
        }
    }
    return act(user);
}

// старт сессии
IResult StartSession(string email)
{
    var usersList = Db.Q("SELECT id, name, email, role FROM users WHERE email = @email", new { email });
    var user = usersList[0];
    var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));

    Db.Exec("INSERT INTO sessions(token, user_id, created) VALUES(@token, @uid, @c)", new { token, uid = user.Int("id"), c = H.Now() });
    return Results.Json(new { token, user = user });
}

// загрузка заявки со всеми расчётными полями
Dictionary<string, object?>? LoadRequest(long id)
{
    var list = Db.Q(H.ReqSql + " WHERE r.id = @id", new { id });
    if (list.Count == 0)
    {
        return null;
    }
    H.Fill(list[0]);
    return list[0];
}

// проверка, что мастер/админ может работать с заявкой
IResult? WorkAccess(Dictionary<string, object?> u, Dictionary<string, object?>? req)
{
    if (req == null)
    {
        return Err("Заявка не найдена", 404);
    }
    if (u.Str("role") == "master" && req.Int("master_id") != u.Int("id"))
    {
        return Err("Эта заявка назначена другому мастеру", 403);
    }
    return null;
}

// запись в историю заявки
void AddLog(long requestId, long? userId, string status, string comment)
{
    Db.Exec("INSERT INTO request_log(request_id, user_id, status, comment, created) VALUES(@rid, @uid, @st, @cm, @c)",
        new { rid = requestId, uid = userId, st = status, cm = comment, c = H.Now() });
}

// ---------- авторизация ----------

// регистрация
app.MapPost("/api/register", (RegisterDto d) =>
{
    string name = (d.Name ?? "").Trim();
    string email = (d.Email ?? "").Trim().ToLowerInvariant();
    string pw = d.Password ?? "";
    string phone = (d.Phone ?? "").Trim();

    if (name.Length < 2 || name.Length > 60)
    {
        return Err("Введите имя (от 2 до 60 символов)");
    }
    if (!H.ValidEmail(email))
    {
        return Err("Некорректный email");
    }
    if (pw.Length < 6 || pw.Length > 100)
    {
        return Err("Пароль - минимум 6 символов");
    }
    if (phone.Length > 0 && !H.ValidPhone(phone))
    {
        return Err("Некорректный телефон");
    }

    long count = Db.Scalar("SELECT COUNT(*) FROM users WHERE email = @email", new { email });
    if (count > 0)
    {
        return Err("Этот email уже зарегистрирован");
    }

    Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES(@name, @email, @phone, @h, 'client', @c)",
        new { name, email, phone, h = H.Hash(pw), c = H.Now() });

    return StartSession(email);
});

// вход
app.MapPost("/api/login", (LoginDto d) =>
{
    string email = (d.Email ?? "").Trim().ToLowerInvariant();
    var usersList = Db.Q("SELECT pass_hash FROM users WHERE email = @email", new { email });

    if (usersList.Count == 0)
    {
        return Err("Неверный email или пароль");
    }

    var user = usersList[0];
    string storedHash = user.Str("pass_hash");

    if (!H.Verify(d.Password ?? "", storedHash))
    {
        return Err("Неверный email или пароль");
    }

    return StartSession(email);
});

// выход
app.MapPost("/api/logout", (HttpRequest r) =>
{
    var authHeader = r.Headers["Authorization"].ToString();
    if (authHeader.StartsWith("Bearer "))
    {
        string token = authHeader.Substring(7);
        Db.Exec("DELETE FROM sessions WHERE token = @t", new { t = token });
    }
    return Results.Json(new { ok = true });
});

app.MapGet("/api/me", (HttpRequest r) => WithRole(r, H.Any, u => Results.Json(u)));

// ---------- справочники и каталог услуг ----------

app.MapGet("/api/categories", () => Results.Json(Db.Q("SELECT id, name FROM categories ORDER BY id")));

// каталог услуг с ориентировочными ценами (только активные)
app.MapGet("/api/services", () =>
{
    var list = Db.Q(@"SELECT s.*, c.name AS category_name FROM services s
                      JOIN categories c ON c.id = s.category_id
                      WHERE s.active = 1 ORDER BY s.category_id, s.id");
    return Results.Json(list);
});

// публичная проверка статуса по коду заявки
app.MapGet("/api/track", (HttpRequest r) =>
{
    string code = r.Query["code"].ToString().Trim().ToUpperInvariant();
    if (!Regex.IsMatch(code, "^[A-Z0-9]{6,12}$"))
    {
        return Err("Введите код заявки из квитанции");
    }

    var list = Db.Q(H.ReqSql + " WHERE r.track_code = @code", new { code });
    if (list.Count == 0)
    {
        return Err("Заявка с таким кодом не найдена", 404);
    }

    var q = list[0];
    long id = q.Int("id");
    var history = Db.Q("SELECT status, created FROM request_log WHERE request_id = @id ORDER BY id", new { id });

    return Results.Json(new
    {
        id,
        device_type = q["device_type"],
        device_model = q["device_model"],
        service_name = q["service_name"],
        status = q["status"],
        created = q["created"],
        due_date = q["due_date"],
        history
    });
});

// ---------- заявки клиента ----------

// создание заявки
app.MapPost("/api/requests", (HttpRequest r, RequestDto d) => WithRole(r, H.Any, u =>
{
    string deviceType = (d.DeviceType ?? "").Trim();
    string model = (d.DeviceModel ?? "").Trim();
    string problem = (d.Problem ?? "").Trim();
    string phone = (d.Phone ?? "").Trim();

    if (deviceType.Length < 2 || deviceType.Length > 60)
    {
        return Err("Укажите тип устройства");
    }
    if (model.Length > 80)
    {
        return Err("Модель - не более 80 символов");
    }
    if (problem.Length < 10)
    {
        return Err("Опишите неисправность подробнее (минимум 10 символов)");
    }
    if (problem.Length > 1000)
    {
        return Err("Описание неисправности - не более 1000 символов");
    }
    if (!H.ValidPhone(phone))
    {
        return Err("Укажите корректный телефон для связи");
    }

    long? serviceId = null;
    if (d.ServiceId != null && d.ServiceId > 0)
    {
        long cnt = Db.Scalar("SELECT COUNT(*) FROM services WHERE id = @id AND active = 1", new { id = d.ServiceId });
        if (cnt == 0)
        {
            return Err("Выбранная услуга не найдена");
        }
        serviceId = d.ServiceId;
    }

    string photo = "";
    if (!string.IsNullOrEmpty(d.Photo))
    {
        string? photoErr = H.SavePhoto(d.Photo, out photo);
        if (photoErr != null)
        {
            return Err(photoErr);
        }
    }

    string code = H.NewCode();
    string now = H.Now();

    Db.Exec(@"INSERT INTO requests(client_id, service_id, device_type, device_model, problem, phone, photo, status, track_code, created, updated)
              VALUES(@cid, @sid, @dt, @dm, @pr, @ph, @pf, 'accepted', @code, @c, @c)",
        new { cid = u.Int("id"), sid = serviceId, dt = deviceType, dm = model, pr = problem, ph = phone, pf = photo, code, c = now });

    long id = Db.Scalar("SELECT id FROM requests WHERE track_code = @code", new { code });
    AddLog(id, u.Int("id"), "accepted", "Заявка создана клиентом");

    return Results.Json(new { ok = true, id, code });
}));

// мои заявки
app.MapGet("/api/requests/my", (HttpRequest r) => WithRole(r, H.Any, u =>
{
    var list = Db.Q(H.ReqSql + " WHERE r.client_id = @uid ORDER BY r.id DESC", new { uid = u.Int("id") });
    foreach (var item in list)
    {
        H.Fill(item);
    }
    return Results.Json(list);
}));

// карточка заявки (клиент - своя, мастер - назначенная, админ - любая)
app.MapGet("/api/requests/{id:long}", (long id, HttpRequest r) => WithRole(r, H.Any, u =>
{
    var q = LoadRequest(id);
    if (q == null)
    {
        return Err("Заявка не найдена", 404);
    }
    if (!H.CanSee(u, q))
    {
        return Err("Нет доступа", 403);
    }

    q["parts"] = Db.Q(@"SELECT rp.id, rp.qty, rp.price, p.name, p.sku FROM request_parts rp
                        JOIN parts p ON p.id = rp.part_id WHERE rp.request_id = @id ORDER BY rp.id", new { id });
    q["log"] = Db.Q(@"SELECT l.status, l.comment, l.created, u.name AS user_name, u.role AS user_role FROM request_log l
                      LEFT JOIN users u ON u.id = l.user_id WHERE l.request_id = @id ORDER BY l.id", new { id });
    q["next"] = H.NextFor(u.Str("role"), q.Str("status"));
    return Results.Json(q);
}));

// отмена заявки клиентом (пока мастер не начал работу)
app.MapPost("/api/requests/{id:long}/cancel", (long id, HttpRequest r) => WithRole(r, H.Any, u =>
{
    var q = LoadRequest(id);
    if (q == null)
    {
        return Err("Заявка не найдена", 404);
    }
    if (u.Str("role") != "admin" && q.Int("client_id") != u.Int("id"))
    {
        return Err("Нет доступа", 403);
    }
    if (q.Str("status") != "accepted")
    {
        return Err("Отменить можно только заявку в статусе «Принята»");
    }

    Db.Exec("UPDATE requests SET status = 'cancelled', updated = @n, closed = @n WHERE id = @id", new { id, n = H.Now() });
    AddLog(id, u.Int("id"), "cancelled", "Заявка отменена");
    return Results.Json(new { ok = true });
}));

// ---------- рабочее место мастера ----------

// заявки мастера (админ видит все)
app.MapGet("/api/work/requests", (HttpRequest r) => WithRole(r, H.Work, u =>
{
    List<Dictionary<string, object?>> list;
    if (u.Str("role") == "master")
    {
        list = Db.Q(H.ReqSql + " WHERE r.master_id = @uid ORDER BY r.id DESC LIMIT 500", new { uid = u.Int("id") });
    }
    else
    {
        list = Db.Q(H.ReqSql + " ORDER BY r.id DESC LIMIT 500");
    }
    foreach (var item in list)
    {
        H.Fill(item);
    }
    return Results.Json(list);
}));

// смена статуса
app.MapPost("/api/work/requests/{id:long}/status", (long id, HttpRequest r, StatusDto d) => WithRole(r, H.Work, u =>
{
    var q = LoadRequest(id);
    var denied = WorkAccess(u, q);
    if (denied != null)
    {
        return denied;
    }

    string role = u.Str("role");
    string cur = q!.Str("status");
    string next = d.Status ?? "";
    string comment = (d.Comment ?? "").Trim();

    if (comment.Length > 500)
    {
        return Err("Комментарий слишком длинный (до 500 символов)");
    }
    if (Array.IndexOf(H.NextFor(role, cur), next) < 0)
    {
        return Err("Нельзя перевести заявку из статуса «" + H.StatusName(cur) + "» в «" + H.StatusName(next) + "»");
    }
    if (next == "issued" && cur != "ready")
    {
        return Err("Выдать можно только заявку в статусе «Готова к выдаче»");
    }
    if (next != "accepted" && next != "cancelled" && q!.Int("master_id") == 0)
    {
        return Err("Сначала назначьте мастера");
    }
    if ((next == "ready" || next == "issued") && q!.Dbl("work_cost") <= 0)
    {
        return Err("Сначала укажите стоимость работ");
    }

    string now = H.Now();
    if (next == "issued" || next == "cancelled")
    {
        Db.Exec("UPDATE requests SET status = @s, updated = @n, closed = @n WHERE id = @id", new { id, s = next, n = now });
    }
    else
    {
        Db.Exec("UPDATE requests SET status = @s, updated = @n WHERE id = @id", new { id, s = next, n = now });
    }

    if (next == "cancelled")
    {
        long returned = H.ReturnParts(id);
        if (returned > 0)
        {
            comment = (comment + " Запчасти возвращены на склад.").Trim();
        }
    }

    if (comment.Length == 0)
    {
        comment = H.DefaultComment(next);
    }
    AddLog(id, u.Int("id"), next, comment);
    return Results.Json(new { ok = true });
}));

// комментарий без смены статуса
app.MapPost("/api/work/requests/{id:long}/comment", (long id, HttpRequest r, CommentDto d) => WithRole(r, H.Work, u =>
{
    var q = LoadRequest(id);
    var denied = WorkAccess(u, q);
    if (denied != null)
    {
        return denied;
    }

    string comment = (d.Comment ?? "").Trim();
    if (comment.Length < 2 || comment.Length > 500)
    {
        return Err("Комментарий - от 2 до 500 символов");
    }

    AddLog(id, u.Int("id"), q!.Str("status"), comment);
    return Results.Json(new { ok = true });
}));

// стоимость работ
app.MapPut("/api/work/requests/{id:long}/cost", (long id, HttpRequest r, CostDto d) => WithRole(r, H.Work, u =>
{
    var q = LoadRequest(id);
    var denied = WorkAccess(u, q);
    if (denied != null)
    {
        return denied;
    }

    string st = q!.Str("status");
    if (st == "issued" || st == "cancelled")
    {
        return Err("Заявка закрыта - стоимость изменить нельзя");
    }
    if (d.WorkCost < 0 || d.WorkCost > 1000000)
    {
        return Err("Стоимость работ - от 0 до 1 000 000 ₽");
    }

    Db.Exec("UPDATE requests SET work_cost = @w, updated = @n WHERE id = @id", new { id, w = Math.Round(d.WorkCost, 2), n = H.Now() });
    AddLog(id, u.Int("id"), st, "Стоимость работ: " + Math.Round(d.WorkCost, 2).ToString("0.##", CultureInfo.InvariantCulture) + " ₽");
    return Results.Json(new { ok = true });
}));

// использованная запчасть
app.MapPost("/api/work/requests/{id:long}/parts", (long id, HttpRequest r, PartUseDto d) => WithRole(r, H.Work, u =>
{
    var q = LoadRequest(id);
    var denied = WorkAccess(u, q);
    if (denied != null)
    {
        return denied;
    }

    string st = q!.Str("status");
    if (st != "diagnostics" && st != "repair")
    {
        return Err("Запчасти можно списывать только в статусах «В диагностике» и «В ремонте»");
    }
    if (d.Qty < 1 || d.Qty > 100)
    {
        return Err("Количество - от 1 до 100");
    }

    var partList = Db.Q("SELECT id, name, price FROM parts WHERE id = @id", new { id = d.PartId });
    if (partList.Count == 0)
    {
        return Err("Запчасть не найдена", 404);
    }
    var part = partList[0];

    int changed = Db.Exec("UPDATE parts SET qty = qty - @n WHERE id = @id AND qty >= @n", new { id = d.PartId, n = d.Qty });
    if (changed == 0)
    {
        long left = Db.Scalar("SELECT qty FROM parts WHERE id = @id", new { id = d.PartId });
        return Err("На складе недостаточно: осталось " + left + " шт.");
    }

    Db.Exec("INSERT INTO request_parts(request_id, part_id, qty, price) VALUES(@rid, @pid, @q, @p)",
        new { rid = id, pid = d.PartId, q = d.Qty, p = part.Dbl("price") });
    Db.Exec("UPDATE requests SET updated = @n WHERE id = @id", new { id, n = H.Now() });
    AddLog(id, u.Int("id"), st, "Использована запчасть: " + part.Str("name") + " × " + d.Qty);
    return Results.Json(new { ok = true });
}));

// убрать запчасть из заявки (возврат на склад)
app.MapDelete("/api/work/requests/{id:long}/parts/{rpId:long}", (long id, long rpId, HttpRequest r) => WithRole(r, H.Work, u =>
{
    var q = LoadRequest(id);
    var denied = WorkAccess(u, q);
    if (denied != null)
    {
        return denied;
    }

    string st = q!.Str("status");
    if (st != "diagnostics" && st != "repair")
    {
        return Err("Изменять запчасти можно только в статусах «В диагностике» и «В ремонте»");
    }

    var rp = Db.Q("SELECT rp.part_id, rp.qty, p.name FROM request_parts rp JOIN parts p ON p.id = rp.part_id WHERE rp.id = @rp AND rp.request_id = @id", new { rp = rpId, id });
    if (rp.Count == 0)
    {
        return Err("Запись не найдена", 404);
    }

    Db.Exec("UPDATE parts SET qty = qty + @n WHERE id = @p", new { n = rp[0].Int("qty"), p = rp[0].Int("part_id") });
    Db.Exec("DELETE FROM request_parts WHERE id = @rp", new { rp = rpId });
    AddLog(id, u.Int("id"), st, "Запчасть возвращена на склад: " + rp[0].Str("name") + " × " + rp[0].Int("qty"));
    return Results.Json(new { ok = true });
}));

// ---------- склад запчастей ----------

app.MapGet("/api/parts", (HttpRequest r) => WithRole(r, H.Work, u =>
{
    var list = Db.Q("SELECT * FROM parts ORDER BY name");
    return Results.Json(list);
}));

// проверка запчасти
string? CheckPart(PartDto d, long? ignoreId)
{
    string name = (d.Name ?? "").Trim();
    string sku = (d.Sku ?? "").Trim();

    if (name.Length < 2 || name.Length > 80)
    {
        return "Название - от 2 до 80 символов";
    }
    if (sku.Length < 2 || sku.Length > 30)
    {
        return "Артикул - от 2 до 30 символов";
    }
    if (d.Qty < 0 || d.Qty > 100000)
    {
        return "Количество - от 0 до 100000";
    }
    if (d.MinQty < 0 || d.MinQty > 1000)
    {
        return "Минимальный остаток - от 0 до 1000";
    }
    if (d.Price <= 0 || d.Price > 1000000)
    {
        return "Цена должна быть больше 0";
    }

    long dup = Db.Scalar("SELECT COUNT(*) FROM parts WHERE sku = @sku AND id != @id", new { sku, id = ignoreId ?? 0 });
    if (dup > 0)
    {
        return "Запчасть с таким артикулом уже есть";
    }
    return null;
}

app.MapPost("/api/admin/parts", (HttpRequest r, PartDto d) => WithRole(r, H.AdminOnly, u =>
{
    string? msg = CheckPart(d, null);
    if (msg != null)
    {
        return Err(msg);
    }

    Db.Exec("INSERT INTO parts(name, sku, qty, min_qty, price) VALUES(@n, @s, @q, @m, @p)",
        new { n = d.Name!.Trim(), s = d.Sku!.Trim(), q = d.Qty, m = d.MinQty, p = Math.Round(d.Price, 2) });
    return Results.Json(new { ok = true });
}));

app.MapPut("/api/admin/parts/{id:long}", (long id, HttpRequest r, PartDto d) => WithRole(r, H.AdminOnly, u =>
{
    long exists = Db.Scalar("SELECT COUNT(*) FROM parts WHERE id = @id", new { id });
    if (exists == 0)
    {
        return Err("Запчасть не найдена", 404);
    }

    string? msg = CheckPart(d, id);
    if (msg != null)
    {
        return Err(msg);
    }

    Db.Exec("UPDATE parts SET name = @n, sku = @s, qty = @q, min_qty = @m, price = @p WHERE id = @id",
        new { id, n = d.Name!.Trim(), s = d.Sku!.Trim(), q = d.Qty, m = d.MinQty, p = Math.Round(d.Price, 2) });
    return Results.Json(new { ok = true });
}));

app.MapDelete("/api/admin/parts/{id:long}", (long id, HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    long used = Db.Scalar("SELECT COUNT(*) FROM request_parts WHERE part_id = @id", new { id });
    if (used > 0)
    {
        return Err("Запчасть использовалась в заявках - удаление невозможно, обнулите остаток");
    }

    Db.Exec("DELETE FROM parts WHERE id = @id", new { id });
    return Results.Json(new { ok = true });
}));

// ---------- администратор: заявки ----------

// назначение мастера
app.MapPut("/api/admin/requests/{id:long}/assign", (long id, HttpRequest r, AssignDto d) => WithRole(r, H.AdminOnly, u =>
{
    var q = LoadRequest(id);
    if (q == null)
    {
        return Err("Заявка не найдена", 404);
    }

    string st = q.Str("status");
    if (st == "issued" || st == "cancelled")
    {
        return Err("Заявка закрыта - мастера менять нельзя");
    }

    var masters = Db.Q("SELECT id, name FROM users WHERE id = @id AND role = 'master'", new { id = d.MasterId });
    if (masters.Count == 0)
    {
        return Err("Выберите мастера из списка");
    }

    Db.Exec("UPDATE requests SET master_id = @m, updated = @n WHERE id = @id", new { id, m = d.MasterId, n = H.Now() });
    AddLog(id, u.Int("id"), st, "Назначен мастер: " + masters[0].Str("name"));
    return Results.Json(new { ok = true });
}));

app.MapGet("/api/admin/masters", (HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    var list = Db.Q("SELECT id, name, email FROM users WHERE role = 'master' ORDER BY name");
    return Results.Json(list);
}));

// ---------- администратор: услуги ----------

app.MapGet("/api/admin/services", (HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    var list = Db.Q(@"SELECT s.*, c.name AS category_name FROM services s
                      JOIN categories c ON c.id = s.category_id ORDER BY s.category_id, s.id");
    return Results.Json(list);
}));

// проверка услуги
string? CheckService(ServiceDto d)
{
    if ((d.Name ?? "").Trim().Length < 2 || (d.Name ?? "").Trim().Length > 80)
    {
        return "Название услуги - от 2 до 80 символов";
    }

    long catCount = Db.Scalar("SELECT COUNT(*) FROM categories WHERE id = @id", new { id = d.CategoryId });
    if (catCount == 0)
    {
        return "Выберите категорию";
    }
    if ((d.Description ?? "").Length > 300)
    {
        return "Описание - не более 300 символов";
    }
    if (d.PriceFrom < 0 || d.PriceFrom > 1000000)
    {
        return "Цена «от» - от 0 до 1 000 000";
    }
    if (d.PriceTo < d.PriceFrom || d.PriceTo > 1000000)
    {
        return "Цена «до» не может быть меньше цены «от»";
    }
    if (d.Days < 1 || d.Days > 60)
    {
        return "Срок ремонта - от 1 до 60 дней";
    }
    return null;
}

app.MapPost("/api/admin/services", (HttpRequest r, ServiceDto d) => WithRole(r, H.AdminOnly, u =>
{
    string? msg = CheckService(d);
    if (msg != null)
    {
        return Err(msg);
    }

    Db.Exec(@"INSERT INTO services(category_id, name, description, price_from, price_to, days, active)
              VALUES(@c, @n, @ds, @pf, @pt, @d, @a)",
        new { c = d.CategoryId, n = d.Name!.Trim(), ds = (d.Description ?? "").Trim(), pf = d.PriceFrom, pt = d.PriceTo, d = d.Days, a = d.Active ? 1 : 0 });
    return Results.Json(new { ok = true });
}));

app.MapPut("/api/admin/services/{id:long}", (long id, HttpRequest r, ServiceDto d) => WithRole(r, H.AdminOnly, u =>
{
    long exists = Db.Scalar("SELECT COUNT(*) FROM services WHERE id = @id", new { id });
    if (exists == 0)
    {
        return Err("Услуга не найдена", 404);
    }

    string? msg = CheckService(d);
    if (msg != null)
    {
        return Err(msg);
    }

    Db.Exec(@"UPDATE services SET category_id = @c, name = @n, description = @ds, price_from = @pf, price_to = @pt, days = @d, active = @a WHERE id = @id",
        new { id, c = d.CategoryId, n = d.Name!.Trim(), ds = (d.Description ?? "").Trim(), pf = d.PriceFrom, pt = d.PriceTo, d = d.Days, a = d.Active ? 1 : 0 });
    return Results.Json(new { ok = true });
}));

app.MapDelete("/api/admin/services/{id:long}", (long id, HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    long used = Db.Scalar("SELECT COUNT(*) FROM requests WHERE service_id = @id", new { id });
    if (used > 0)
    {
        return Err("Услуга использовалась в заявках - скройте её из каталога вместо удаления");
    }

    Db.Exec("DELETE FROM services WHERE id = @id", new { id });
    return Results.Json(new { ok = true });
}));

app.MapPost("/api/admin/categories", (HttpRequest r, CatDto d) => WithRole(r, H.AdminOnly, u =>
{
    string name = (d.Name ?? "").Trim();
    if (name.Length < 2 || name.Length > 40)
    {
        return Err("Название категории - от 2 до 40 символов");
    }

    long count = Db.Scalar("SELECT COUNT(*) FROM categories WHERE name = @name", new { name });
    if (count > 0)
    {
        return Err("Такая категория уже есть");
    }

    Db.Exec("INSERT INTO categories(name) VALUES(@name)", new { name });
    return Results.Json(new { ok = true });
}));

// ---------- администратор: пользователи ----------

app.MapGet("/api/admin/users", (HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    var users = Db.Q("SELECT id, name, email, phone, role, created FROM users ORDER BY id");
    return Results.Json(users);
}));

app.MapPost("/api/admin/users", (HttpRequest r, UserDto d) => WithRole(r, H.AdminOnly, u =>
{
    string name = (d.Name ?? "").Trim();
    string email = (d.Email ?? "").Trim().ToLowerInvariant();
    string role = d.Role ?? "";

    if (name.Length < 2 || name.Length > 60)
    {
        return Err("Введите имя (от 2 до 60 символов)");
    }
    if (!H.ValidEmail(email))
    {
        return Err("Некорректный email");
    }
    if ((d.Password ?? "").Length < 6)
    {
        return Err("Пароль - минимум 6 символов");
    }
    if (!H.ValidRole(role))
    {
        return Err("Некорректная роль");
    }

    long count = Db.Scalar("SELECT COUNT(*) FROM users WHERE email = @email", new { email });
    if (count > 0)
    {
        return Err("Этот email уже зарегистрирован");
    }

    Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES(@name, @email, '', @h, @role, @c)",
        new { name, email, h = H.Hash(d.Password!), role, c = H.Now() });
    return Results.Json(new { ok = true });
}));

app.MapPut("/api/admin/users/{id:long}/role", (long id, HttpRequest r, RoleDto d) => WithRole(r, H.AdminOnly, u =>
{
    string role = d.Role ?? "";
    if (!H.ValidRole(role))
    {
        return Err("Некорректная роль");
    }
    if (id == u.Int("id"))
    {
        return Err("Нельзя изменить роль самому себе");
    }

    var target = Db.Q("SELECT role FROM users WHERE id = @id", new { id });
    if (target.Count == 0)
    {
        return Err("Пользователь не найден", 404);
    }

    if (target[0].Str("role") == "master" && role != "master")
    {
        long active = Db.Scalar("SELECT COUNT(*) FROM requests WHERE master_id = @id AND status IN ('accepted','diagnostics','repair','ready')", new { id });
        if (active > 0)
        {
            return Err("У мастера есть незавершённые заявки - сначала передайте их другому");
        }
    }

    Db.Exec("UPDATE users SET role = @role WHERE id = @id", new { id, role });
    return Results.Json(new { ok = true });
}));

app.MapDelete("/api/admin/users/{id:long}", (long id, HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    if (id == u.Int("id"))
    {
        return Err("Нельзя удалить самого себя");
    }

    long count = Db.Scalar("SELECT COUNT(*) FROM requests WHERE client_id = @id OR master_id = @id", new { id });
    if (count > 0)
    {
        return Err("У пользователя есть заявки - удаление невозможно");
    }

    Db.Exec("DELETE FROM users WHERE id = @id", new { id });
    return Results.Json(new { ok = true });
}));

// ---------- статистика ----------

app.MapGet("/api/stats", (HttpRequest r) => WithRole(r, H.AdminOnly, u =>
{
    double revenue = Db.Num("SELECT COALESCE(SUM(r.work_cost + " + H.PartsCostSql + "), 0) FROM requests r WHERE r.status = 'issued'");
    long total = Db.Scalar("SELECT COUNT(*) FROM requests WHERE status != 'cancelled'");
    long active = Db.Scalar("SELECT COUNT(*) FROM requests WHERE status IN ('accepted','diagnostics','repair','ready')");
    long fresh = Db.Scalar("SELECT COUNT(*) FROM requests WHERE status = 'accepted' AND master_id IS NULL");
    long lowParts = Db.Scalar("SELECT COUNT(*) FROM parts WHERE qty <= min_qty");

    var months = Db.Q(@"SELECT substr(r.created, 1, 7) AS m, COUNT(*) AS cnt,
                               COALESCE(SUM(CASE WHEN r.status = 'issued' THEN r.work_cost + " + H.PartsCostSql + @" ELSE 0 END), 0) AS sum
                        FROM requests r WHERE r.status != 'cancelled' GROUP BY m ORDER BY m DESC LIMIT 6");
    months.Reverse();

    var statuses = new List<Dictionary<string, object?>>();
    foreach (var s in H.Statuses)
    {
        var row = new Dictionary<string, object?>();
        row["status"] = s;
        row["name"] = H.StatusName(s);
        row["cnt"] = Db.Scalar("SELECT COUNT(*) FROM requests WHERE status = @s", new { s });
        statuses.Add(row);
    }

    var devices = Db.Q("SELECT device_type AS name, COUNT(*) AS cnt FROM requests WHERE status != 'cancelled' GROUP BY device_type ORDER BY cnt DESC, name LIMIT 5");

    var top = Db.Q(@"SELECT COALESCE(s.name, r.device_type) AS name, COUNT(*) AS cnt FROM requests r
                     LEFT JOIN services s ON s.id = r.service_id WHERE r.status != 'cancelled'
                     GROUP BY COALESCE(s.name, r.device_type) ORDER BY cnt DESC, name LIMIT 6");

    var masters = Db.Q(@"SELECT u.name, COALESCE(SUM(CASE WHEN r.status IN ('accepted','diagnostics','repair','ready') THEN 1 ELSE 0 END), 0) AS cnt
                         FROM users u LEFT JOIN requests r ON r.master_id = u.id WHERE u.role = 'master' GROUP BY u.id ORDER BY cnt DESC, u.name");

    return Results.Json(new { revenue, total, active, fresh, lowParts, months, statuses, devices, top, masters });
}));

// запуск браузера
app.Lifetime.ApplicationStarted.Register(() =>
{
    try
    {
        string url = "http://localhost:5081";
        if (OperatingSystem.IsWindows())
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        else if (OperatingSystem.IsMacOS())
        {
            Process.Start("open", url);
        }
        else
        {
            Process.Start("xdg-open", url);
        }
    }
    catch
    {
    }
});

app.Run();

// модели данных
record RegisterDto(string? Name, string? Email, string? Password, string? Phone);
record LoginDto(string? Email, string? Password);
record RequestDto(string? DeviceType, string? DeviceModel, string? Problem, string? Phone, long? ServiceId, string? Photo);
record StatusDto(string? Status, string? Comment);
record CommentDto(string? Comment);
record CostDto(double WorkCost);
record PartUseDto(long PartId, int Qty);
record AssignDto(long MasterId);
record ServiceDto(string? Name, long CategoryId, string? Description, double PriceFrom, double PriceTo, int Days, bool Active);
record CatDto(string? Name);
record PartDto(string? Name, string? Sku, int Qty, int MinQty, double Price);
record UserDto(string? Name, string? Email, string? Password, string? Role);
record RoleDto(string? Role);

// вспомогательный класс для словарей
static class X
{
    public static string Str(this Dictionary<string, object?> d, string k)
    {
        var val = d[k];
        if (val == null) return "";
        return Convert.ToString(val, CultureInfo.InvariantCulture) ?? "";
    }

    public static long Int(this Dictionary<string, object?> d, string k)
    {
        var val = d[k];
        if (val == null) return 0;
        return Convert.ToInt64(val, CultureInfo.InvariantCulture);
    }

    public static double Dbl(this Dictionary<string, object?> d, string k)
    {
        var val = d[k];
        if (val == null) return 0;
        return Convert.ToDouble(val, CultureInfo.InvariantCulture);
    }
}

// вспомогательные методы
static class H
{
    public static readonly string[] Any = Array.Empty<string>();
    public static readonly string[] Work = new[] { "master", "admin" };
    public static readonly string[] AdminOnly = new[] { "admin" };
    public static readonly string[] Statuses = new[] { "accepted", "diagnostics", "repair", "ready", "issued", "cancelled" };

    public static string UploadDir = "";

    // стоимость запчастей по заявке
    public const string PartsCostSql = "(SELECT COALESCE(SUM(p.qty * p.price), 0) FROM request_parts p WHERE p.request_id = r.id)";

    // общий запрос заявок с именами клиента, мастера и услуги
    public const string ReqSql = @"SELECT r.*, s.name AS service_name, cu.name AS client_name, cu.email AS client_email,
        mu.name AS master_name,
        " + PartsCostSql + @" AS parts_cost,
        date(r.created, '+' || COALESCE(s.days, 3) || ' days') AS due_date
        FROM requests r
        LEFT JOIN services s ON s.id = r.service_id
        JOIN users cu ON cu.id = r.client_id
        LEFT JOIN users mu ON mu.id = r.master_id";

    public static string FindRoot()
    {
        string[] starts = new string[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory };
        foreach (var start in starts)
        {
            var d = new DirectoryInfo(start);
            while (d != null)
            {
                string wwwrootPath = Path.Combine(d.FullName, "wwwroot");
                string csprojPath = Path.Combine(d.FullName, "RepairApp.csproj");

                if (Directory.Exists(wwwrootPath) && File.Exists(csprojPath))
                {
                    return d.FullName;
                }
                d = d.Parent;
            }
        }
        return Directory.GetCurrentDirectory();
    }

    public static string Now()
    {
        return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
    }

    public static string StatusName(string s)
    {
        switch (s)
        {
            case "accepted": return "Принята";
            case "diagnostics": return "В диагностике";
            case "repair": return "В ремонте";
            case "ready": return "Готова к выдаче";
            case "issued": return "Выдана";
            case "cancelled": return "Отменена";
            default: return s;
        }
    }

    public static string DefaultComment(string s)
    {
        switch (s)
        {
            case "accepted": return "Заявка принята";
            case "diagnostics": return "Начата диагностика";
            case "repair": return "Диагностика завершена, выполняется ремонт";
            case "ready": return "Ремонт завершён, устройство готово к выдаче";
            case "issued": return "Устройство выдано клиенту";
            case "cancelled": return "Заявка отменена";
            default: return "";
        }
    }

    // доступные переходы статусов
    public static string[] NextFor(string role, string st)
    {
        if (st == "issued" || st == "cancelled")
        {
            return Array.Empty<string>();
        }

        if (role == "admin")
        {
            var all = new List<string> { "accepted", "diagnostics", "repair", "ready", "issued", "cancelled" };
            all.Remove(st);
            if (st != "ready")
            {
                all.Remove("issued");
            }
            return all.ToArray();
        }

        if (role == "master")
        {
            switch (st)
            {
                case "accepted": return new[] { "diagnostics" };
                case "diagnostics": return new[] { "repair", "ready" };
                case "repair": return new[] { "ready", "diagnostics" };
                case "ready": return new[] { "issued", "repair" };
            }
        }
        return Array.Empty<string>();
    }

    // итоговая сумма заявки
    public static void Fill(Dictionary<string, object?> q)
    {
        q["total"] = Math.Round(q.Dbl("work_cost") + q.Dbl("parts_cost"), 2);
    }

    public static bool CanSee(Dictionary<string, object?> u, Dictionary<string, object?> req)
    {
        string role = u.Str("role");
        if (role == "admin") return true;
        if (role == "master" && req.Int("master_id") == u.Int("id")) return true;
        return req.Int("client_id") == u.Int("id");
    }

    public static bool ValidRole(string role)
    {
        return role == "client" || role == "master" || role == "admin";
    }

    public static bool ValidEmail(string e)
    {
        if (e.Length < 5 || e.Length > 100)
        {
            return false;
        }

        int at = e.IndexOf('@');
        if (at <= 0)
        {
            return false;
        }
        if (at != e.LastIndexOf('@'))
        {
            return false;
        }
        if (e.IndexOf('.', at) <= at + 1)
        {
            return false;
        }
        if (e.EndsWith(".") || e.Contains(' '))
        {
            return false;
        }

        return true;
    }

    public static bool ValidPhone(string p)
    {
        if (!Regex.IsMatch(p, @"^\+?[0-9()\-\s]{10,20}$"))
        {
            return false;
        }
        int digits = p.Count(char.IsDigit);
        return digits >= 10 && digits <= 15;
    }

    public static string Hash(string pw)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var key = Rfc2898DeriveBytes.Pbkdf2(pw, salt, 100000, HashAlgorithmName.SHA256, 32);
        return Convert.ToBase64String(salt) + ":" + Convert.ToBase64String(key);
    }

    public static bool Verify(string pw, string stored)
    {
        var parts = stored.Split(':');
        if (parts.Length != 2)
        {
            return false;
        }

        var salt = Convert.FromBase64String(parts[0]);
        var key = Rfc2898DeriveBytes.Pbkdf2(pw, salt, 100000, HashAlgorithmName.SHA256, 32);
        var storedKey = Convert.FromBase64String(parts[1]);

        return CryptographicOperations.FixedTimeEquals(key, storedKey);
    }

    // уникальный код заявки для проверки статуса
    public static string NewCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        while (true)
        {
            var chars = new char[8];
            for (int i = 0; i < chars.Length; i++)
            {
                chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
            }
            string code = new string(chars);
            if (Db.Scalar("SELECT COUNT(*) FROM requests WHERE track_code = @code", new { code }) == 0)
            {
                return code;
            }
        }
    }

    // сохранение фото из data-URL с проверкой типа по сигнатуре
    public static string? SavePhoto(string data, out string url)
    {
        url = "";
        int comma = data.IndexOf(',');
        if (!data.StartsWith("data:image/") || comma < 0)
        {
            return "Некорректный формат фото";
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(data.Substring(comma + 1));
        }
        catch
        {
            return "Некорректный формат фото";
        }

        if (bytes.Length > 3 * 1024 * 1024)
        {
            return "Фото слишком большое (максимум 3 МБ)";
        }

        string ext;
        if (bytes.Length > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF)
        {
            ext = ".jpg";
        }
        else if (bytes.Length > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47)
        {
            ext = ".png";
        }
        else if (bytes.Length > 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
                 && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
        {
            ext = ".webp";
        }
        else
        {
            return "Допустимы только фото JPG, PNG или WebP";
        }

        string name = Guid.NewGuid().ToString("N") + ext;
        File.WriteAllBytes(Path.Combine(UploadDir, name), bytes);
        url = "/uploads/" + name;
        return null;
    }

    // возврат запчастей на склад при отмене заявки
    public static long ReturnParts(long requestId)
    {
        var list = Db.Q("SELECT part_id, qty FROM request_parts WHERE request_id = @id", new { id = requestId });
        long total = 0;
        foreach (var x in list)
        {
            Db.Exec("UPDATE parts SET qty = qty + @n WHERE id = @p", new { n = x.Int("qty"), p = x.Int("part_id") });
            total += x.Int("qty");
        }
        Db.Exec("DELETE FROM request_parts WHERE request_id = @id", new { id = requestId });
        return total;
    }
}

// работа с базой данных
static class Db
{
    public static string DbFile = "";

    static SqliteConnection Open()
    {
        var c = new SqliteConnection("Data Source=" + DbFile);
        c.Open();
        using var m = c.CreateCommand();
        m.CommandText = "PRAGMA foreign_keys = ON;";
        m.ExecuteNonQuery();
        return c;
    }

    static void Bind(SqliteCommand m, object? p)
    {
        if (p == null)
        {
            return;
        }

        foreach (var pr in p.GetType().GetProperties())
        {
            var val = pr.GetValue(p);
            if (val == null)
            {
                val = DBNull.Value;
            }
            m.Parameters.AddWithValue("@" + pr.Name, val);
        }
    }

    public static List<Dictionary<string, object?>> Q(string sql, object? p = null)
    {
        using var c = Open();
        using var m = c.CreateCommand();
        m.CommandText = sql;
        Bind(m, p);
        using var r = m.ExecuteReader();

        var list = new List<Dictionary<string, object?>>();
        while (r.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < r.FieldCount; i++)
            {
                if (r.IsDBNull(i))
                {
                    row[r.GetName(i)] = null;
                }
                else
                {
                    row[r.GetName(i)] = r.GetValue(i);
                }
            }
            list.Add(row);
        }
        return list;
    }

    public static int Exec(string sql, object? p = null)
    {
        using var c = Open();
        using var m = c.CreateCommand();
        m.CommandText = sql;
        Bind(m, p);
        return m.ExecuteNonQuery();
    }

    public static long Scalar(string sql, object? p = null)
    {
        using var c = Open();
        using var m = c.CreateCommand();
        m.CommandText = sql;
        Bind(m, p);
        var o = m.ExecuteScalar();

        if (o == null || o is DBNull)
        {
            return 0;
        }
        return Convert.ToInt64(o, CultureInfo.InvariantCulture);
    }

    public static double Num(string sql, object? p = null)
    {
        using var c = Open();
        using var m = c.CreateCommand();
        m.CommandText = sql;
        Bind(m, p);
        var o = m.ExecuteScalar();

        if (o == null || o is DBNull)
        {
            return 0;
        }
        return Convert.ToDouble(o, CultureInfo.InvariantCulture);
    }

    public static void Init()
    {
        Exec(@"
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('client', 'master', 'admin')),
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_from REAL NOT NULL CHECK(price_from >= 0),
  price_to REAL NOT NULL,
  days INTEGER NOT NULL DEFAULT 3 CHECK(days >= 1 AND days <= 60),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  CHECK(price_to >= price_from)
);
CREATE TABLE IF NOT EXISTS parts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  qty INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
  min_qty INTEGER NOT NULL DEFAULT 2 CHECK(min_qty >= 0),
  price REAL NOT NULL CHECK(price > 0)
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  master_id INTEGER REFERENCES users(id),
  service_id INTEGER REFERENCES services(id),
  device_type TEXT NOT NULL,
  device_model TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL,
  phone TEXT NOT NULL,
  photo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('accepted', 'diagnostics', 'repair', 'ready', 'issued', 'cancelled')),
  work_cost REAL NOT NULL DEFAULT 0 CHECK(work_cost >= 0),
  track_code TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  closed TEXT
);
CREATE TABLE IF NOT EXISTS request_parts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL CHECK(qty > 0),
  price REAL NOT NULL CHECK(price >= 0)
);
CREATE TABLE IF NOT EXISTS request_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_master ON requests(master_id);
CREATE INDEX IF NOT EXISTS idx_log_request ON request_log(request_id);");

        long userCount = Scalar("SELECT COUNT(*) FROM users");
        if (userCount == 0)
        {
            Seed();
        }
    }

    static void Seed()
    {
        var now = H.Now();

        // пользователи: 1 админ, 2-3 мастера, 4-5 клиенты
        Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES('Администратор', 'admin@mail.ru', '', @h, 'admin', @c)", new { h = H.Hash("admin123"), c = now });
        Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES('Игорь Мастеров', 'master@mail.ru', '+7 913 000-11-22', @h, 'master', @c)", new { h = H.Hash("master123"), c = now });
        Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES('Анна Паяльникова', 'master2@mail.ru', '+7 913 000-33-44', @h, 'master', @c)", new { h = H.Hash("master123"), c = now });
        Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES('Марк Светаев', 'client@mail.ru', '+7 923 111-22-33', @h, 'client', @c)", new { h = H.Hash("client123"), c = now });
        Db.Exec("INSERT INTO users(name, email, phone, pass_hash, role, created) VALUES('Елена Орлова', 'client2@mail.ru', '+7 923 444-55-66', @h, 'client', @c)", new { h = H.Hash("client123"), c = now });

        Db.Exec("INSERT INTO categories(name) VALUES('Смартфоны и планшеты'), ('Ноутбуки и ПК'), ('Бытовая техника'), ('Диагностика')");

        // услуги: категория, название, описание, цена от, цена до, срок (дней)
        var services = new (int Cat, string Name, string Desc, double From, double To, int Days)[]
        {
            (1, "Замена экрана смартфона", "Дисплейный модуль с тачскрином, проверка после установки.", 2500, 9000, 2),
            (1, "Замена аккумулятора", "Новая батарея, калибровка, проверка зарядки.", 1200, 3000, 1),
            (1, "Ремонт разъёма зарядки", "Замена или пайка порта, чистка контактов.", 1000, 2500, 2),
            (1, "Ремонт после попадания влаги", "Ультразвуковая чистка платы, замена повреждённых элементов.", 1500, 5000, 4),
            (2, "Чистка и замена термопасты", "Разборка, удаление пыли, новая термопаста и проверка температур.", 1200, 2000, 1),
            (2, "Замена клавиатуры ноутбука", "Подбор и установка клавиатуры под модель.", 1800, 4500, 3),
            (2, "Установка и переустановка Windows", "Установка системы, драйверов и базовых программ.", 1000, 2000, 1),
            (2, "Замена SSD/HDD с переносом данных", "Установка накопителя, клонирование системы.", 1500, 3500, 2),
            (2, "Ремонт материнской платы", "Диагностика цепей питания, перепайка компонентов.", 3000, 12000, 7),
            (3, "Ремонт стиральной машины", "Замена тэна, подшипников, насоса, ремонт электроники.", 1500, 6000, 5),
            (3, "Ремонт телевизора", "Подсветка, блок питания, материнская плата.", 2000, 8000, 5),
            (4, "Диагностика любой техники", "Выявление неисправности и расчёт стоимости ремонта.", 0, 800, 1)
        };
        foreach (var s in services)
        {
            Db.Exec("INSERT INTO services(category_id, name, description, price_from, price_to, days, active) VALUES(@c, @n, @d, @f, @t, @dy, 1)",
                new { c = s.Cat, n = s.Name, d = s.Desc, f = s.From, t = s.To, dy = s.Days });
        }

        // запчасти: название, артикул, остаток, минимальный остаток, цена
        var parts = new (string Name, string Sku, int Qty, int Min, double Price)[]
        {
            ("Дисплей iPhone 11 (копия)", "DSP-IP11", 6, 2, 3500),
            ("Дисплей Samsung A52", "DSP-SA52", 4, 2, 4200),
            ("Аккумулятор iPhone 11", "BAT-IP11", 10, 3, 1200),
            ("Аккумулятор Samsung A52", "BAT-SA52", 8, 3, 1100),
            ("Разъём зарядки Type-C", "CON-TC", 25, 10, 150),
            ("Термопаста MX-4", "PST-MX4", 15, 5, 350),
            ("Клавиатура для ноутбука ASUS", "KB-ASUS", 3, 2, 1500),
            ("SSD 240 ГБ SATA", "SSD-240", 7, 3, 2200),
            ("Оперативная память DDR4 8 ГБ", "RAM-D4-8", 9, 3, 2000),
            ("Подсветка для ТВ 43\" (комплект)", "LED-TV43", 2, 2, 2800),
            ("Тэн для стиральной машины", "HT-WM", 4, 2, 900),
            ("Подшипники для стиральной машины", "BR-WM", 5, 2, 1100),
            ("Блок питания для ТВ", "PSU-TV", 1, 2, 2500)
        };
        foreach (var p in parts)
        {
            Db.Exec("INSERT INTO parts(name, sku, qty, min_qty, price) VALUES(@n, @s, 1000, @m, @p)",
                new { n = p.Name, s = p.Sku, m = p.Min, p = p.Price });
        }

        // шаблоны устройств для тестовых заявок по номеру услуги: тип, модель, проблема, запчасть
        var tpl = new (string Dev, string Model, string Problem, int Part)[]
        {
            ("Смартфон", "iPhone 11", "Разбит экран, сенсор не отзывается на нажатия", 1),
            ("Смартфон", "Samsung Galaxy A52", "Быстро разряжается, выключается на 30 процентах", 4),
            ("Смартфон", "Xiaomi Redmi Note 10", "Не заряжается, разъём шатается", 5),
            ("Смартфон", "iPhone 11", "Залит водой, не включается", 0),
            ("Ноутбук", "Lenovo IdeaPad 3", "Сильно греется и шумит вентилятор", 6),
            ("Ноутбук", "ASUS VivoBook 15", "Не работают несколько клавиш", 7),
            ("Компьютер", "Сборка Ryzen 5", "Windows не загружается, синий экран", 0),
            ("Ноутбук", "HP Pavilion 15", "Очень медленно работает, нужен SSD", 8),
            ("Ноутбук", "Acer Nitro 5", "Не включается, нет изображения", 0),
            ("Стиральная машина", "Bosch WAN 2426", "Не нагревает воду при стирке", 11),
            ("Телевизор", "Samsung UE43", "Нет подсветки, звук есть", 10),
            ("Планшет", "iPad 8", "Периодически зависает, нужна диагностика", 0)
        };

        var order = new[] { "accepted", "diagnostics", "repair", "ready", "issued" };
        var partPrice = new Dictionary<int, double>();
        for (int i = 0; i < parts.Length; i++)
        {
            partPrice[i + 1] = parts[i].Price;
        }

        // создание тестовой заявки с историей статусов
        void Req(long client, long? master, int service, string status, int daysAgo, double work)
        {
            var t = tpl[service - 1];
            var created = DateTime.Today.AddDays(-daysAgo).AddHours(10);
            string code = H.NewCode();
            string cs = created.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            int finalIdx = Array.IndexOf(order, status);
            if (status == "cancelled")
            {
                finalIdx = 0;
            }
            var last = created.AddHours(Math.Max(finalIdx, 0) * 5);
            if (last > DateTime.Now) last = DateTime.Now;
            string ls = last.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            string? closed = (status == "issued" || status == "cancelled") ? ls : null;
            string phone = client == 4 ? "+7 923 111-22-33" : "+7 923 444-55-66";

            Db.Exec(@"INSERT INTO requests(client_id, master_id, service_id, device_type, device_model, problem, phone, photo, status, work_cost, track_code, created, updated, closed)
                      VALUES(@cl, @m, @s, @dt, @dm, @pr, @ph, '', @st, @w, @code, @c, @u, @cl2)",
                new { cl = client, m = master, s = service, dt = t.Dev, dm = t.Model, pr = t.Problem, ph = phone, st = status, w = work, code, c = cs, u = ls, cl2 = closed });
            long id = Db.Scalar("SELECT id FROM requests WHERE track_code = @code", new { code });

            // история
            for (int i = 0; i <= Math.Max(finalIdx, 0); i++)
            {
                var at = created.AddHours(i * 5);
                if (at > DateTime.Now) at = DateTime.Now;
                long? who = i == 0 ? client : master;
                Db.Exec("INSERT INTO request_log(request_id, user_id, status, comment, created) VALUES(@r, @u, @s, @c, @t)",
                    new { r = id, u = who, s = order[i], c = i == 0 ? "Заявка создана клиентом" : H.DefaultComment(order[i]), t = at.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) });
            }
            if (status == "cancelled")
            {
                Db.Exec("INSERT INTO request_log(request_id, user_id, status, comment, created) VALUES(@r, @u, 'cancelled', 'Заявка отменена', @t)",
                    new { r = id, u = client, t = ls });
            }

            // запчасть, если заявка дошла до ремонта
            if (t.Part > 0 && finalIdx >= 2 && status != "cancelled")
            {
                Db.Exec("INSERT INTO request_parts(request_id, part_id, qty, price) VALUES(@r, @p, 1, @pr)",
                    new { r = id, p = t.Part, pr = partPrice[t.Part] });
            }
        }

        // архив: выданные заявки за последние 5 месяцев
        var rnd = new Random(11);
        for (int m = 5; m >= 1; m--)
        {
            int count = 3 + rnd.Next(0, 4);
            for (int k = 0; k < count; k++)
            {
                int service = rnd.Next(1, 13);
                long client = rnd.Next(0, 2) == 0 ? 4 : 5;
                long master = rnd.Next(0, 2) == 0 ? 2 : 3;
                var s = services[service - 1];
                double work = Math.Round((s.From + rnd.NextDouble() * (s.To - s.From)) / 100) * 100;
                if (work <= 0) work = 500;
                Req(client, master, service, "issued", m * 30 - rnd.Next(0, 20), work);
            }
        }

        // текущие заявки
        Req(4, 2, 1, "repair", 2, 2500);
        Req(4, 3, 5, "diagnostics", 1, 0);
        Req(5, null, 2, "accepted", 0, 0);
        Req(5, null, 10, "accepted", 0, 0);
        Req(4, 3, 11, "ready", 5, 2000);
        Req(5, 2, 3, "repair", 3, 1000);
        Req(4, null, 4, "cancelled", 9, 0);
        Req(5, 2, 8, "issued", 8, 1500);

        // итоговые остатки склада
        var finalQty = new[] { 5, 4, 8, 7, 22, 14, 2, 6, 8, 1, 3, 4, 1 };
        for (int i = 0; i < finalQty.Length; i++)
        {
            Db.Exec("UPDATE parts SET qty = @q WHERE id = @id", new { q = finalQty[i], id = i + 1 });
        }
    }
}
